import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import type { ReviewRequest, ReviewResult } from '../events.js'
import { lastCompletedReview } from '../review-history.js'
import type { ReviewSkillProfile } from '../skills-tool.js'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { CodeAccess, EngineRunOptions } from '../engine.js'
import type {} from '../engine-row.js'
import { gitlabAuthHeaders } from '../forge/gitlab/gitlab-auth.js'
import { resolveIgnoreGlobs } from '../diff-filter.js'
import { DEFAULT_FANOUT, type FanoutSettings } from '../chunking.js'
import { REPO_CONFIG_PATH, effectiveConfig, parseRepoConfig, type RepoReviewConfig } from '../repo-config.js'
import { fetchRepoFile } from '../forge/gitlab/mr-api.js'
import { gateExitCode, toCodeQuality, type ReviewGate } from '../codequality.js'
import { buildCommandPrompt, commandMarker, findPendingCommands, type PendingCommand } from '../ci-commands.js'
import type { FindingSeverity } from '../review-findings-tool.js'
import { fetchBotUserId, hasCompletedDeepReview, hasCompletedReviewForSha, hasRunningEyes, latestCompletedReview, removeDeepLabel } from '../ci-coexist.js'

export const name = 'maestro-review-ci-trigger'
export const inject = ['reviewEngine', 'agentDefaultModel'] as const

const CI_AGENT_TIMEOUT_MS = 1_200_000

const REVIEW_PROFILES = ['magento2', 'laravel', 'symfony', 'wordpress', 'generic'] as const

export interface CiEnvConfig {
  gitlabBaseUrl: string
  /** Bare host the source is cloned from (GITLAB_HOST). */
  gitlabHost: string
  gitlabToken: string
  /** The token's username, which marks the bot's own notes, threads and awards. */
  botUsername: string
  /** Pinned review model (REVIEW_MODEL_PROVIDER / REVIEW_MODEL); absent = the host default. */
  reviewModel?: { provider: string; model: string }
  agentTimeoutMs: number
  sourceProjectId: number
  mrIid: number
  mode: 'quick' | 'deep'
  dryRun: boolean
  reviewProfile?: ReviewSkillProfile
  /** Mirror of Settings UI autoRereviewOnPush (default off): re-review new pushes. */
  rereviewOnPush: boolean
  /** The MR carries the deep label (written by the resolve job): one deep review per head SHA. */
  deepRequested: boolean
  /** Paths kept from the model: the defaults plus REVIEW_IGNORE_GLOBS. */
  ignoreGlobs: string[]
  /** REVIEW_FANOUT_FILES / _BYTES / _CONCURRENCY over DEFAULT_FANOUT. */
  fanout: FanoutSettings
  /** Only the REVIEW_IGNORE_GLOBS entries and fan-out values the environment sets, to layer over the repo file. */
  envIgnoreGlobs: string[]
  envFanout: Partial<FanoutSettings>
  /** REVIEW_GATE: `blocking` fails the review job on a blocking finding (operator only, default off). */
  gate: ReviewGate
  /** REVIEW_DEEP_MODEL_PROVIDER + REVIEW_DEEP_MODEL: the model of high risk fan-out parts. */
  deepModel?: { provider: string; model: string }
}

export const CiEnvConfig: z<CiEnvConfig> = z.object({
  gitlabBaseUrl: z.string().required(),
  gitlabHost: z.string().required(),
  gitlabToken: z.string().role('secret').required(),
  botUsername: z.string().required(),
  reviewModel: z.union([z.object({ provider: z.string(), model: z.string() }), z.const(undefined)]),
  agentTimeoutMs: z.natural().default(CI_AGENT_TIMEOUT_MS),
  sourceProjectId: z.number().required(),
  mrIid: z.number().required(),
  mode: z.union([z.const('quick'), z.const('deep')]).default('quick'),
  dryRun: z.boolean().default(false),
  reviewProfile: z.union([z.const('magento2'), z.const('laravel'), z.const('symfony'), z.const('wordpress'), z.const('generic')]),
  rereviewOnPush: z.boolean().default(false),
  deepRequested: z.boolean().default(false),
  ignoreGlobs: z.array(z.string()).required(),
  fanout: z.object({ files: z.natural().required(), bytes: z.natural().required(), concurrency: z.natural().required() }).required(),
  deepModel: z.union([z.object({ provider: z.string(), model: z.string() }), z.const(undefined)]),
  gate: z.union([z.const('off'), z.const('blocking')]).default('off'),
  envIgnoreGlobs: z.array(z.string()).required(),
  envFanout: z.object({ files: z.natural(), bytes: z.natural(), concurrency: z.natural() }).required(),
})

/** A positive integer env value, or the default when unset; anything else fails the job naming the variable. */
function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return Number(raw)
}

/**
 * Reads the CI contract env vars (spec §5.2) — not Cordis-supplied config, since these are
 * per-run values a static profile config cannot hold. schemastery's `.required()` only rejects
 * `undefined`, not an empty string, so GITLAB_HOST/REVIEW_GITLAB_TOKEN presence is checked here
 * before defaulting to `''` — otherwise a missing env var would silently pass validation.
 */
export function parseCiEnvConfig(env: Record<string, string | undefined>): CiEnvConfig {
  if (env.GITLAB_HOST === undefined) throw new Error('missing GITLAB_HOST')
  if (env.REVIEW_GITLAB_TOKEN === undefined) throw new Error('missing REVIEW_GITLAB_TOKEN')
  if (env.REVIEW_GATE !== undefined && env.REVIEW_GATE !== '' && env.REVIEW_GATE !== 'off' && env.REVIEW_GATE !== 'blocking') {
    throw new Error(`unsupported REVIEW_GATE "${env.REVIEW_GATE}" (supported: off, blocking)`)
  }
  if (env.REVIEW_PROFILE !== undefined && !(REVIEW_PROFILES as readonly string[]).includes(env.REVIEW_PROFILE)) {
    throw new Error(`unsupported REVIEW_PROFILE "${env.REVIEW_PROFILE}" (supported: ${REVIEW_PROFILES.join(', ')})`)
  }
  return CiEnvConfig({
    gitlabBaseUrl: `https://${env.GITLAB_HOST}`,
    gitlabHost: env.GITLAB_HOST.trim(),
    gitlabToken: env.REVIEW_GITLAB_TOKEN,
    // A personal or project token posts as its own username, not "maestro-bot".
    botUsername: env.REVIEW_BOT_USERNAME || 'maestro-bot',
    agentTimeoutMs: CI_AGENT_TIMEOUT_MS,
    // Optional as a pair: a model without a provider fails the review with a
    // provider error instead of silently calling the wrong model.
    ...(env.REVIEW_MODEL ? { reviewModel: { provider: env.REVIEW_MODEL_PROVIDER as string, model: env.REVIEW_MODEL } } : {}),
    sourceProjectId: Number(env.SOURCE_PROJECT_ID),
    mrIid: Number(env.MR_IID),
    // A deep request from the resolve job wins over REVIEW_MODE: project variables
    // outrank the child pipeline's own values, so REVIEW_MODE alone could be quick.
    mode: env.REVIEW_DEEP_REQUESTED === '1' || env.REVIEW_MODE === 'deep' ? 'deep' : 'quick',
    dryRun: env.REVIEW_DRY_RUN === '1',
    reviewProfile: env.REVIEW_PROFILE as ReviewSkillProfile | undefined,
    rereviewOnPush: env.REVIEW_ON_PUSH === '1',
    deepRequested: env.REVIEW_DEEP_REQUESTED === '1',
    ignoreGlobs: resolveIgnoreGlobs(env),
    fanout: {
      files: positiveInt(env, 'REVIEW_FANOUT_FILES', DEFAULT_FANOUT.files),
      bytes: positiveInt(env, 'REVIEW_FANOUT_BYTES', DEFAULT_FANOUT.bytes),
      concurrency: positiveInt(env, 'REVIEW_FANOUT_CONCURRENCY', DEFAULT_FANOUT.concurrency),
    },
    gate: env.REVIEW_GATE === 'blocking' ? 'blocking' : 'off',
    envIgnoreGlobs: (env.REVIEW_IGNORE_GLOBS ?? '').split(',').map((g) => g.trim()).filter((g) => g !== ''),
    envFanout: Object.fromEntries(([['files', 'REVIEW_FANOUT_FILES'], ['bytes', 'REVIEW_FANOUT_BYTES'], ['concurrency', 'REVIEW_FANOUT_CONCURRENCY']] as const)
      .filter(([, name]) => (env[name] ?? '').trim() !== '')
      .map(([key, name]) => [key, positiveInt(env, name, DEFAULT_FANOUT[key])])),
    ...(env.REVIEW_DEEP_MODEL ? { deepModel: { provider: env.REVIEW_DEEP_MODEL_PROVIDER as string, model: env.REVIEW_DEEP_MODEL } } : {}),
  })
}

/** The one field a webhook payload carries that env vars don't — orchestrator fetches the diff itself. */
export async function fetchMrSourceBranch(config: CiEnvConfig, fetcher: typeof fetch = fetch): Promise<string> {
  return (await fetchMrDetail(config, fetcher)).sourceBranch
}

/** MR detail pieces CI needs in one call: source branch (worktree) + head SHA (push-gate) + project path (comment header/link). */
export async function fetchMrDetail(config: CiEnvConfig, fetcher: typeof fetch = fetch): Promise<{ sourceBranch: string; headSha: string; projectPath: string; targetBranch?: string }> {
  const url = `${config.gitlabBaseUrl}/api/v4/projects/${config.sourceProjectId}/merge_requests/${config.mrIid}`
  const res = await fetcher(url, { headers: gitlabAuthHeaders(config.gitlabToken) })
  if (!res.ok) throw new Error(`GitLab API error ${res.status}: ${await res.text()}`)
  const body = await res.json() as { source_branch?: string; target_branch?: string; sha?: string; references?: { full?: string } }
  if (typeof body.source_branch !== 'string') throw new Error('GitLab merge request response is missing source_branch')
  if (typeof body.sha !== 'string') throw new Error('GitLab merge request response is missing sha')
  // references.full looks like "group/sub/project!123" — the real path feeds the
  // comment header and View-MR link. Absent on old servers: fall back to project/<id>.
  const full = body.references?.full
  const projectPath = typeof full === 'string' && full.includes('!') ? full.slice(0, full.indexOf('!')) : `project/${config.sourceProjectId}`
  return { sourceBranch: body.source_branch, headSha: body.sha, projectPath, ...(typeof body.target_branch === 'string' ? { targetBranch: body.target_branch } : {}) }
}

/**
 * How CI reaches the code: quick with no or the generic profile reads the
 * diff only (no clone cost); a framework profile and every deep review clone
 * the source at the head SHA. Deep never audits a runtime here (no environment).
 */
export function ciAccess(config: CiEnvConfig): CodeAccess {
  const checkout = config.mode === 'deep' || (config.reviewProfile !== undefined && config.reviewProfile !== 'generic')
  return checkout ? { kind: 'clone', host: config.gitlabHost } : { kind: 'diff' }
}

/** The fan-out engine options of the job. */
export function ciFanout(config: CiEnvConfig): Pick<EngineRunOptions, 'fanout' | 'deepModel'> {
  return { fanout: config.fanout, ...(config.deepModel !== undefined ? { deepModel: config.deepModel } : {}) }
}

/** The pinned model, else the host default (no Settings UI in CI). */
export function ciModel(ctx: Context, config: CiEnvConfig): ModelSelection {
  if (config.reviewModel !== undefined) return { provider: config.reviewModel.provider, model: config.reviewModel.model }
  return ctx.agentDefaultModel?.currentSelection() ?? { provider: 'fallback', model: 'fallback' }
}

export async function runCiTrigger(
  ctx: Context,
  config: CiEnvConfig,
  deps: {
    fetcher?: typeof fetch
    writeFile?: typeof import('node:fs/promises').writeFile
    history?: { lastCompletedReview(projectId: number, mrIid: number): Promise<{ headSha?: string } | undefined> }
  } = {},
): Promise<ReviewResult> {
  // Boot: process start (dsh launch, profile load) up to this plugin's run.
  const bootMs = Math.round(performance.now())
  const gateStart = Date.now()
  let gateMs: number | undefined
  const { sourceBranch, headSha, projectPath, targetBranch } = await fetchMrDetail(config, deps.fetcher)
  // Per-project settings from the target branch: an MR cannot relax its own review.
  let file: RepoReviewConfig = {}
  const warnings: string[] = []
  if (targetBranch !== undefined) {
    try {
      const text = await fetchRepoFile(deps.fetcher ?? fetch, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, ref: targetBranch, path: REPO_CONFIG_PATH })
      if (text !== undefined) {
        const parsed = parseRepoConfig(text)
        file = parsed.config
        warnings.push(...parsed.warnings)
      }
    } catch (err) {
      warnings.push(`${REPO_CONFIG_PATH} could not be read (${err instanceof Error ? err.message : String(err)}); using the defaults`)
    }
  }
  const eff = effectiveConfig({ ...(config.reviewProfile !== undefined ? { profile: config.reviewProfile } : {}), ignoreGlobs: config.envIgnoreGlobs, fanout: config.envFanout }, file)
  const effConfig: CiEnvConfig = { ...config, reviewProfile: eff.profile, ignoreGlobs: eff.ignoreGlobs, fanout: eff.fanout }
  // Push-gate (mirror of the webhook autoRereviewOnPush semantics): the bridge fires
  // on every MR pipeline, so skip when this exact head SHA already completed — and
  // skip new pushes too unless REVIEW_ON_PUSH=1. A re-run then gets the H6 incremental
  // block from history for free. Cache miss (no history) fails open toward running.
  // State comes from GitLab (spec §4.1): the newest bot review comment. The runner
  // cache is per runner and races across concurrent jobs, so it is only a fallback
  // when GitLab cannot be read.
  const history = deps.history ?? { lastCompletedReview }
  let prior: { headSha?: string; baseSha?: string; partial?: boolean; findings?: Array<{ code: string; fingerprint: string; severity: string }> } | undefined
  let botUserId: number | undefined
  try {
    botUserId = await fetchBotUserId(deps.fetcher ?? fetch, config.gitlabBaseUrl, config.gitlabToken)
    prior = await latestCompletedReview(deps.fetcher ?? fetch, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, mrIid: config.mrIid, botUserId })
  } catch (err) {
    console.error(`[review] review state unreadable from GitLab (${err instanceof Error ? err.message : String(err)}), falling back to the runner cache`)
    prior = await history.lastCompletedReview(config.sourceProjectId, config.mrIid)
  }
  // The reviewer-ci profile's own projectMappings is always [], so the
  // orchestrator's mapping lookup on projectPath never matches regardless
  // of its exact value — but the real path feeds the comment header and
  // View-MR link, so prefer it over the synthetic project/<id> fallback.
  const options: EngineRunOptions = {
    gitlab: { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, botUsername: config.botUsername },
    access: ciAccess(effConfig),
    reviewProfile: effConfig.reviewProfile,
    model: ciModel(ctx, config),
    agentTimeoutMs: config.agentTimeoutMs,
    ignoreGlobs: effConfig.ignoreGlobs,
    ...ciFanout(effConfig),
    repo: { rules: eff.rules, warnings, ...(eff.minSeverity !== undefined ? { minSeverity: eff.minSeverity } : {}), ...(eff.language !== undefined ? { language: eff.language } : {}) },
  }
  const request = (extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
    projectPath,
    projectId: config.sourceProjectId,
    mrIid: config.mrIid,
    sourceBranch,
    headSha,
    ...(prior?.headSha !== undefined ? { priorHeadSha: prior.headSha } : {}),
    ...(prior?.baseSha !== undefined ? { priorBaseSha: prior.baseSha } : {}),
    ...(prior?.partial === true ? { priorPartial: true } : {}),
    trigger: 'mention',
    mode: config.mode,
    scope: { kind: 'mr' },
    reviewProfile: effConfig.reviewProfile,
    ...extra,
  })
  const runReview = (extra: Partial<ReviewRequest> = {}, more: Partial<EngineRunOptions> = {}) => { gateMs = Date.now() - gateStart; return ctx.reviewEngine.run(request(extra), { ...options, ...more }) }
  const coFetcher = deps.fetcher ?? fetch
  // MR commands wait for the next review job; answer them before the push-gate decides.
  const reply = async (discussionId: string, body: string) => {
    const res = await coFetcher(`${config.gitlabBaseUrl}/api/v4/projects/${config.sourceProjectId}/merge_requests/${config.mrIid}/discussions/${encodeURIComponent(discussionId)}/notes`, {
      method: 'POST', headers: { ...gitlabAuthHeaders(config.gitlabToken), 'content-type': 'application/json' }, body: JSON.stringify({ body }),
    })
    if (!res.ok) throw new Error(`GitLab ${res.status} posting a command answer`)
  }
  let pending: PendingCommand[] = []
  if (botUserId !== undefined) {
    pending = await findPendingCommands(coFetcher, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, mrIid: config.mrIid, botUserId })
      .catch((err: unknown) => { console.warn(`[review] MR commands unreadable: ${err instanceof Error ? err.message : String(err)}`); return [] })
  }
  let answered = 0
  for (const c of pending) {
    if (c.command.kind === 'rereview') continue
    const text = c.finding === undefined
      ? '`/maestro explain` and `/maestro fix` work as a reply inside a review finding thread; `/maestro rereview [path]` works anywhere.'
      : await ctx.reviewEngine.answer(request(), options, buildCommandPrompt(c.command, c.finding)).catch((err: unknown) => `Could not answer: ${err instanceof Error ? err.message : String(err)}`)
    await reply(c.discussionId, `${text}\n\n${commandMarker(c.noteId)}`).then(() => { answered++ })
      .catch((err: unknown) => console.warn(`[review] command answer not posted: ${err instanceof Error ? err.message : String(err)}`))
  }
  const rereview = pending.find((c) => c.command.kind === 'rereview')
  let result: ReviewResult
  if (config.deepRequested) {
    // A deep label is an explicit request: it bypasses the quick push-gate and
    // runs once per head SHA. The label is removed once the request is met.
    let met = false
    if (botUserId !== undefined && await hasCompletedDeepReview(coFetcher, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, mrIid: config.mrIid, botUserId, sha: headSha })) {
      result = { ok: true, summary: `deep review already completed at ${headSha}, skipping`, failures: [], durationMs: 0 }
      met = true
    } else if (await hasRunningEyes(coFetcher, config.gitlabBaseUrl, config.gitlabToken, config.sourceProjectId, config.mrIid, botUserId)) {
      result = { ok: true, summary: 'another review is running, skipping', failures: [], durationMs: 0 }
    } else {
      result = await runReview()
      met = result.ok
    }
    if (met) {
      await removeDeepLabel(coFetcher, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, mrIid: config.mrIid })
        .catch((err: unknown) => console.warn(`[review] could not remove the deep label: ${err instanceof Error ? err.message : String(err)}`))
    }
  } else if (rereview !== undefined) {
    // An explicit request: past the push-gate, limited to its path.
    // A path-limited rereview must not weaken the gate: it needs a full review of this head to
    // carry (its severities stay in the gate and the metadata), else the whole MR is reviewed.
    const asked = rereview.command.kind === 'rereview' ? rereview.command.path : undefined
    const full = prior?.headSha === headSha && prior.findings !== undefined ? prior.findings : undefined
    const path = asked !== undefined && full !== undefined ? asked : undefined
    result = path !== undefined && full !== undefined
      ? await runReview({ pathPrefix: path }, { carryFindings: full })
      : await runReview()
    if (full !== undefined && path !== undefined) result = { ...result, gateSeverities: [...(result.gateSeverities ?? []), ...full.map((f) => f.severity)] }
    const note = result.ok ? `Re-reviewed ${path === undefined ? 'the whole MR' : `\`${path}\``} at ${headSha.slice(0, 8)}; see the review comment.` : `The re-review failed: ${result.failures[0] ?? 'unknown error'}`
    await reply(rereview.discussionId, `${note}\n\n${commandMarker(rereview.noteId)}`).then(() => { answered++ })
      .catch((err: unknown) => console.warn(`[review] rereview answer not posted: ${err instanceof Error ? err.message : String(err)}`))
  } else if (prior?.headSha === headSha) {
    // A rerun of a reviewed head must not slip past the gate: carry that review's severities.
    result = { ok: true, summary: `already reviewed at ${headSha}, skipping`, failures: [], durationMs: 0, ...(prior.findings !== undefined ? { gateSeverities: prior.findings.map((f) => f.severity) } : {}) }
  } else if (prior !== undefined && !config.rereviewOnPush) {
    result = { ok: true, summary: `new commits since ${prior.headSha} but REVIEW_ON_PUSH is not set, skipping`, failures: [], durationMs: 0 }
  } else if (await hasCompletedReviewForSha(coFetcher, config.gitlabBaseUrl, config.gitlabToken, config.sourceProjectId, config.mrIid, headSha, botUserId)) {
    // Coexistence (CI yields to webhook): the CI history store is invisible to
    // the webhook flow and vice versa, so check the MR itself for a completed
    // review marker of this SHA or an in-flight eyes marker before booting.
    result = { ok: true, summary: `webhook already reviewed ${headSha}, skipping`, failures: [], durationMs: 0 }
  } else if (await hasRunningEyes(coFetcher, config.gitlabBaseUrl, config.gitlabToken, config.sourceProjectId, config.mrIid, botUserId)) {
    result = { ok: true, summary: 'another review is running, skipping', failures: [], durationMs: 0 }
  } else {
    result = await runReview()
  }
  if (answered > 0) result = { ...result, summary: `${result.summary ?? ''} (answered ${answered} command(s))`.trim() }
  const { writeFile } = deps.writeFile !== undefined ? { writeFile: deps.writeFile } : await import('node:fs/promises')
  // entrypoint.sh cds into deepseek-harness before execing dsh, so a bare relative
  // path would land inside the harness checkout (lost with the container). The
  // entrypoint exports REVIEW_REPORT_DIR=$PWD captured before the cd, so reports land
  // in the CI job's working directory where `artifacts:` picks them up.
  const reportDir = process.env.REVIEW_REPORT_DIR?.trim() || '.'
  const stages = { ...result.stages, boot: bootMs, fetch: (result.stages?.fetch ?? 0) + (gateMs ?? Date.now() - gateStart) }
  const report = { ...result, stages, projectId: config.sourceProjectId, mrIid: config.mrIid, mode: config.mode, generatedAt: new Date().toISOString() }
  await writeFile(join(reportDir, 'review-report.json'), JSON.stringify(report, null, 2), 'utf-8')
  // Always written, `[]` when the run posted nothing, so the artifact report never goes missing.
  await writeFile(join(reportDir, 'gl-code-quality-report.json'), JSON.stringify(toCodeQuality(result.findings ?? []), null, 2), 'utf-8')
  const md = `# Review Report\n\n**Project:** ${config.sourceProjectId} !${config.mrIid}\n**Mode:** ${config.mode}\n**Duration:** ${result.durationMs}ms\n\n${result.summary ?? '(no summary)'}\n${result.failures.length > 0 ? `\nFailures:\n${result.failures.map(f => `- ${f}`).join('\n')}\n` : ''}`
  await writeFile(join(reportDir, 'review-report.md'), md, 'utf-8')
  return result
}

/** 1 on an infra failure, 3 when the operator's gate meets a blocking finding, else 0. */
export function ciExitCode(result: ReviewResult, config: Pick<CiEnvConfig, 'gate'>): 0 | 1 | 3 {
  if (!result.ok) return 1
  const carried = (result.gateSeverities ?? []).map((severity) => ({ status: 'new' as const, body: '', severity: severity as FindingSeverity }))
  return gateExitCode([...(result.findings ?? []), ...carried], config.gate)
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    void (async () => {
      try {
        const config = parseCiEnvConfig(process.env)
        console.log(`[review] ci-trigger starting: project ${config.sourceProjectId} !${config.mrIid} mode=${config.mode} dryRun=${config.dryRun}`)
        const result = config.dryRun
          ? { ok: true, summary: '[dry-run] config valid, skipping review', failures: [], durationMs: 0 }
          : await runCiTrigger(ctx, config)
        console.log(`[review] ci-trigger finished: ok=${result.ok} summary=${JSON.stringify(result.summary)} failures=${result.failures.length}`)
        for (const failure of result.failures) console.error(`[review] ci-trigger failure: ${failure}`)
        const exit = ctx.get('appExit')
        if (exit === undefined) {
          console.error('[review] ctx.get(\'appExit\') is undefined — the launcher did not provide it, process cannot signal its real exit code')
        } else {
          exit(ciExitCode(result, config))
        }
      } catch (err) {
        console.error('maestro-review-ci-trigger:', err instanceof Error ? err.message : String(err))
        ctx.get('appExit')?.(1)
      }
    })()
    return () => {}
  }, 'maestro-review-ci-trigger run')
}
