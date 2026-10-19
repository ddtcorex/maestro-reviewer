import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReviewSkillProfile } from './skills-tool.js'
import {
  RUNTIME_KEYS,
  readFlat,
  writeLegacyPatch,
} from './vendor/store.js'

export interface ReviewModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ProjectMapping {
  projectPath: string
  localRepoPath: string
  reviewProfile?: ReviewSkillProfile
  reviewModel?: ReviewModelSelection
  /** Per-project override of autoRereviewOnPush (undefined = inherit global). */
  rereviewOnPush?: boolean
  /** Per-project override of autoReviewOnAssign (undefined = inherit global). */
  reviewOnAssign?: boolean
}

export interface MaestroUserConfig {
  gitlabBaseUrl?: string
  gitlabToken?: string
  botUsername?: string
  webhookSecret?: string
  webhookPort?: number
  projectMappings?: Array<ProjectMapping>
  /** Override the DSH default model for automated reviews. When absent the global DSH default is used. */
  reviewModel?: ReviewModelSelection
  /** Re-run a quick review whenever new commits land on a previously reviewed MR. */
  autoRereviewOnPush?: boolean
  /** Trigger an automatic quick review when the bot is assigned as MR reviewer (default true). */
  autoReviewOnAssign?: boolean
  /** Bound one automated review agent's turn. */
  agentTimeoutMs?: number
  /** Prune Maestro's own review records older than this many days (0 = keep forever). */
  reviewSessionRetentionDays?: number
  tunnelMode?: 'quick' | 'named'
  quickTarget?: 'dsh-web' | 'webhook'
  tunnelId?: string
  tunnelCredentialsFile?: string
  tunnelHostname?: string
  proxyPort?: number
  proxyHost?: string
  lastTunnelRunning?: boolean
  /** Gate LAN access behind a second PIN. Default false — LAN stays open. */
  lanPinEnabled?: boolean
  /**
   * Login-cookie lifetime for the remote PIN gate, in hours. `0` = session
   * cookie; absent = 24. Owned by dsh-maestro-remote; declared here because
   * this package's settings RPC is the writer.
   */
  pinSessionTtlHours?: number
  /** Telegram Bot API credentials for one-way notifications. */
  telegramBotToken?: string
  telegramChatId?: string
  /** Also notify this chat when a review finishes. Default false. */
  telegramReviewNotifications?: boolean
}

function resolveDshHome(dshHome?: string): string {
  return dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * The keys review reads and may persist: its own gitlab + review settings, plus
 * the one machine-runtime flag that belongs to its own sidecar.
 *
 * Deliberately the READ counterpart of `SAVABLE_KEYS` in `settings-rpc.ts`, plus
 * `lastTunnelRunning` — which review reads from its sidecar and never writes to
 * the shared store. Keep both in step: a key here that is not savable is a read
 * review needs but cannot change, and a savable key missing here is one the UI
 * could write but never read back.
 */
const REVIEW_OWNED_KEYS = [
  'gitlabBaseUrl', 'gitlabToken', 'botUsername', 'webhookSecret', 'webhookPort',
  'projectMappings', 'autoRereviewOnPush', 'autoReviewOnAssign',
  'reviewModel', 'agentTimeoutMs', 'reviewSessionRetentionDays',
  'lastTunnelRunning',
] as const satisfies readonly (keyof MaestroUserConfig)[]

/**
 * Settings live in the SHARED namespaced store (`~/.dsh/dsh-maestro-config/settings.json`,
 * owned by dsh-maestro-core and embedded here at `src/host/vendor/store.ts`); this store is a thin adapter that
 * keeps the package's flat `MaestroUserConfig` API while delegating persistence.
 * Machine runtime state (RUNTIME_KEYS) never enters settings — it stays in this
 * package's own sidecar so a settings edit can never silently flip tunnel state.
 */
export function runtimeStatePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'dsh-maestro-review', 'runtime.json')
}

async function readRuntimeState(dshHome?: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(runtimeStatePath(dshHome), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function mergeRuntimeState(
  patch: Record<string, unknown>,
  dshHome?: string,
): Promise<void> {
  const path = runtimeStatePath(dshHome)
  const merged = { ...(await readRuntimeState(dshHome)), ...patch }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
  await chmod(path, 0o600)
}

export async function loadUserConfig(dshHome?: string): Promise<MaestroUserConfig> {
  const [flat, runtime] = await Promise.all([
    readFlat({ dshHome }),
    readRuntimeState(dshHome),
  ])
  // Scope the read to the keys review OWNS. `readFlat` returns the WHOLE store
  // view — every `DOMAIN_KEY_MAP` key across every domain — so returning it
  // unfiltered made review's own settings RPC (`/dsh-maestro-review`,
  // `maestro.getConfig`) answer with remote's tunnel identity: `tunnelHostname`,
  // `tunnelId`, `tunnelCredentialsFile` (the local path of the machine's
  // Cloudflare credentials file), `lanPort`, `lanPinEnabled`, `proxyPort`,
  // `pinSessionTtlHours` — plus the notifier's telegram token and chat id.
  //
  // The leak was one-directional and therefore invisible: `SAVABLE_KEYS` already
  // rejected every one of those keys on a WRITE (with `OWNER_OF` naming the
  // owning plugin), and nothing in review reads them — but the read side handed
  // them to the client anyway.
  //
  // An ALLOWLIST, not a denylist, so a key added to the shared store later
  // cannot leak by default. `tests/config-scope.spec.ts` pins the set.
  const scoped: Record<string, unknown> = {}
  for (const key of REVIEW_OWNED_KEYS) {
    const value = flat[key as string]
    if (value !== undefined) scoped[key as string] = value
    const local = runtime[key as string]
    if (local !== undefined) scoped[key as string] = local
  }
  return scoped as MaestroUserConfig
}

export async function saveUserConfig(patch: MaestroUserConfig, dshHome?: string): Promise<MaestroUserConfig> {
  const settingsPatch: Record<string, unknown> = {}
  const runtimePatch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if ((RUNTIME_KEYS as readonly string[]).includes(key)) runtimePatch[key] = value
    else settingsPatch[key] = value
  }
  if (Object.keys(settingsPatch).length > 0) {
    await writeLegacyPatch(settingsPatch, { dshHome })
  }
  if (Object.keys(runtimePatch).length > 0) {
    await mergeRuntimeState(runtimePatch, dshHome)
  }
  return loadUserConfig(dshHome)
}
