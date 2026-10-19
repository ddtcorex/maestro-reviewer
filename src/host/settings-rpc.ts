import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { RpcErrorDetailsMap, RpcResult } from '@deepseek-ai/dsh-client-connection'
import { existsSync, statSync } from 'node:fs'
import { loadUserConfig, saveUserConfig, type MaestroUserConfig } from './config-store.js'
import { listReviews } from './review-history.js'

export const name = 'maestro-settings-rpc'
/**
 * `maestroTunnel` used to be a hard dependency here, which meant a review-only
 * install could never activate this row: the service is provided by
 * dsh-maestro-remote. The tunnel endpoints moved to their owner, so nothing
 * here needs it any more.
 */
export const inject = ['connection']

/**
 * Keys the Settings card may persist; anything else is a rejected save.
 *
 * This set is deliberately NARROWER than the store's `DOMAIN_KEY_MAP`. In
 * particular `lanPort` and `lanHost` are absent and must stay absent: they are
 * machine-local, and a harness sync rewrites `domains.tunnel` from the
 * per-machine tunnel profile, so a Settings write for either key is discarded
 * without a word. `tests/settings-rpc-savable-keys.test.ts` pins that.
 */
const SAVABLE_KEYS = new Set<keyof MaestroUserConfig>([
  'gitlabBaseUrl', 'gitlabToken', 'botUsername', 'webhookSecret', 'webhookPort',
  'projectMappings', 'autoRereviewOnPush', 'autoReviewOnAssign',
  'reviewModel', 'agentTimeoutMs', 'reviewSessionRetentionDays',
])

/**
 * Which plugin owns a key this one no longer serves, so a rejected save names
 * the place the setting actually moved to instead of just "unknown key".
 */
const OWNER_OF: Record<string, string> = {
  tunnelMode: 'dsh-maestro-remote',
  quickTarget: 'dsh-maestro-remote',
  tunnelId: 'dsh-maestro-remote',
  tunnelCredentialsFile: 'dsh-maestro-remote',
  tunnelHostname: 'dsh-maestro-remote',
  proxyPort: 'dsh-maestro-remote',
  proxyHost: 'dsh-maestro-remote',
  lanPinEnabled: 'dsh-maestro-remote',
  pinSessionTtlHours: 'dsh-maestro-remote',
  telegramBotToken: 'dsh-maestro-notifier',
  telegramChatId: 'dsh-maestro-notifier',
  telegramReviewNotifications: 'dsh-maestro-notifier',
}

function validateReviewModel(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'reviewModel must be an object.'
  const { provider, model, reasoningEffort } = value as Record<string, unknown>
  if (typeof provider !== 'string' || provider.trim() === '') return 'reviewModel.provider must be a non-empty string.'
  if (typeof model !== 'string' || model.trim() === '') return 'reviewModel.model must be a non-empty string.'
  if (reasoningEffort !== undefined && typeof reasoningEffort !== 'string') return 'reviewModel.reasoningEffort must be a string.'
  if (typeof reasoningEffort === 'string' && reasoningEffort.trim() === '') return 'reviewModel.reasoningEffort must be a non-empty string when provided.'
  return null
}

/** Secrets never returned to the client; the UI learns only their presence. */
const SECRET_KEYS = ['gitlabToken', 'webhookSecret', 'telegramBotToken'] as const

function maskSecrets(config: MaestroUserConfig): MaestroUserConfig & Record<string, boolean> {
  const masked: Record<string, unknown> = { ...config }
  for (const key of SECRET_KEYS) {
    if (typeof config[key] === 'string' && config[key] !== '') {
      delete masked[key]
      masked[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = true
    }
  }
  return masked as MaestroUserConfig & Record<string, boolean>
}

/**
 * Validate a save payload from the Settings card. Secrets follow a
 * three-state rule: absent keeps the stored value, `''` clears it, a
 * non-empty string replaces it. A mapping's `localRepoPath` must be an
 * existing directory containing a `.git` entry, because reviews check out
 * worktrees from it.
 */
function validateSavePayload(payload: unknown): { ok: true; patch: Partial<MaestroUserConfig> } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: 'Settings payload must be a JSON object.' }
  }
  const patch: Partial<MaestroUserConfig> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!SAVABLE_KEYS.has(key as keyof MaestroUserConfig)) {
      const owner = OWNER_OF[key]
      return { ok: false, message: `Unknown settings key "${key}"${owner ? ` (owned by ${owner})` : ''}.` }
    }
    if (key === 'projectMappings') {
      if (!Array.isArray(value)) return { ok: false, message: 'projectMappings must be an array.' }
      for (const mapping of value) {
        if (typeof mapping !== 'object' || mapping === null) return { ok: false, message: 'Each project mapping must be an object.' }
        const { projectPath, localRepoPath, reviewModel } = mapping as Record<string, unknown>
        if (typeof projectPath !== 'string' || projectPath.trim() === '') return { ok: false, message: 'Each mapping needs a non-empty projectPath.' }
        if (typeof localRepoPath !== 'string' || localRepoPath.trim() === '') return { ok: false, message: 'Each mapping needs a non-empty localRepoPath.' }
        if (localRepoPath !== '/' && !(localRepoPath as string).startsWith('/')) {
          return { ok: false, message: `localRepoPath "${String(localRepoPath)}" must be an absolute path.` }
        }
        if (!existsSync(localRepoPath) || !statSync(localRepoPath).isDirectory() || !existsSync(`${localRepoPath}/.git`)) {
          return { ok: false, message: `localRepoPath "${localRepoPath}" is not an existing git repository checkout.` }
        }
        if (reviewModel !== undefined) {
          const err = validateReviewModel(reviewModel)
          if (err !== null) return { ok: false, message: `projectMappings reviewModel: ${err}` }
        }
      }
    }
    if (key === 'reviewModel') {
      if (value === null) {
        patch[key as keyof MaestroUserConfig] = undefined as never
        continue
      }
      const err = validateReviewModel(value)
      if (err !== null) return { ok: false, message: err }
    }
    if (key === 'webhookPort' && value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535)) {
      return { ok: false, message: 'webhookPort must be an integer between 1 and 65535.' }
    }
    if (key === 'agentTimeoutMs' && value !== undefined && (typeof value !== 'number' || value < 1000)) {
      return { ok: false, message: 'agentTimeoutMs must be at least 1000 ms.' }
    }
    // Mirror of MAX_PIN_SESSION_TTL_HOURS in dsh-maestro-remote: the two packages
    // ship independently, so the boundary test below — not a shared constant — is
    // what keeps them in step.
    if (key === 'pinSessionTtlHours' && value !== undefined &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 8760)) {
      return { ok: false, message: 'pinSessionTtlHours must be an integer between 0 and 8760.' }
    }
    if (key === 'reviewSessionRetentionDays' && value !== undefined && (typeof value !== 'number' || value < 0)) {
      return { ok: false, message: 'reviewSessionRetentionDays must be 0 (off) or a positive number of days.' }
    }
    patch[key as keyof MaestroUserConfig] = value as never
  }
  return { ok: true, patch }
}

export const MAESTRO_RPC_CHANNEL = '/maestro-reviewer'
/**
 * The three endpoints review still serves. The tunnel, proxy and PIN endpoints
 * moved to dsh-maestro-remote, which already provides the `maestroTunnel`
 * service this row used to depend on, and the telegram ones to
 * dsh-maestro-notifier. Endpoint strings never changed; only the channel that
 * carries them, so each owner keeps the same literal its clients already call.
 */
export const MAESTRO_ENDPOINTS = Object.freeze({
  getConfig: 'maestro.getConfig',
  saveConfig: 'maestro.saveConfig',
  reviewsList: 'maestro.reviews.list',
})

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail(message: string): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message,
      // Synthetic details, not real Zod validation output: `bad-request`'s real `details`
      // shape is `{ issues: ZodIssue[] }` from the `zod` package (a specific discriminated
      // union), but this is an app-level "unknown endpoint" error being shoehorned into
      // DSH's shared RPC error taxonomy, not an actual Zod-validated payload. Constructing
      // a byte-perfect ZodIssue here would be disproportionate, so we cast this one value
      // to the narrow per-code details type (not the wider `RpcError['details']` union,
      // which doesn't satisfy the 'bad-request' discriminant on its own).
      details: { issues: [{ message }] } as RpcErrorDetailsMap['bad-request'],
    },
  }
}

export function apply(ctx: Context): void {
  const handler = async (endpoint: string, payload: unknown) => {
    if (endpoint === MAESTRO_ENDPOINTS.getConfig) {
      return ok(maskSecrets(await loadUserConfig()))
    }
    if (endpoint === MAESTRO_ENDPOINTS.saveConfig) {
      const validated = validateSavePayload(payload)
      if (!validated.ok) return fail(validated.message)
      const merged = await saveUserConfig(validated.patch)
      return ok(maskSecrets(merged))
    }
      if (endpoint === MAESTRO_ENDPOINTS.reviewsList) {
      return ok(await listReviews(20))
    }
    return fail(`Unknown endpoint: ${endpoint}`)
  }
  const disposeRpc = ctx.connection.rpc.handle(MAESTRO_RPC_CHANNEL, handler)

  ctx.effect(() => () => { disposeRpc(); }, 'maestro-settings-rpc teardown')
}
