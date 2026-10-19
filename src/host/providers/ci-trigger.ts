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
import { gitlabAuthHeaders } from '../gitlab-auth.js'
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
})

/**
 * Reads the CI contract env vars (spec §5.2) — not Cordis-supplied config, since these are
 * per-run values a static profile config cannot hold. schemastery's `.required()` only rejects
 * `undefined`, not an empty string, so GITLAB_HOST/MAESTRO_GITLAB_TOKEN presence is checked here
 * before defaulting to `''` — otherwise a missing env var would silently pass validation.
 */
export function parseCiEnvConfig(env: Record<string, string | undefined>): CiEnvConfig {
  if (env.GITLAB_HOST === undefined) throw new Error('missing GITLAB_HOST')
  if (env.MAESTRO_GITLAB_TOKEN === undefined) throw new Error('missing MAESTRO_GITLAB_TOKEN')
  if (env.REVIEW_PROFILE !== undefined && !(REVIEW_PROFILES as readonly string[]).includes(env.REVIEW_PROFILE)) {
    throw new Error(`unsupported REVIEW_PROFILE "${env.REVIEW_PROFILE}" (supported: ${REVIEW_PROFILES.join(', ')})`)
  }
  return CiEnvConfig({
    gitlabBaseUrl: `https://${env.GITLAB_HOST}`,
    gitlabHost: env.GITLAB_HOST.trim(),
    gitlabToken: env.MAESTRO_GITLAB_TOKEN,
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
  })
}

/** The one field a webhook payload carries that env vars don't — orchestrator fetches the diff itself. */
export async function fetchMrSourceBranch(config: CiEnvConfig, fetcher: typeof fetch = fetch): Promise<string> {
  return (await fetchMrDetail(config, fetcher)).sourceBranch
}

/** MR detail pieces CI needs in one call: source branch (worktree) + head SHA (push-gate) + project path (comment header/link). */
export async function fetchMrDetail(config: CiEnvConfig, fetcher: typeof fetch = fetch): Promise<{ sourceBranch: string; headSha: string; projectPath: string }> {
  const url = `${config.gitlabBaseUrl}/api/v4/projects/${config.sourceProjectId}/merge_requests/${config.mrIid}`
  const res = await fetcher(url, { headers: gitlabAuthHeaders(config.gitlabToken) })
  if (!res.ok) throw new Error(`GitLab API error ${res.status}: ${await res.text()}`)
  const body = await res.json() as { source_branch?: string; sha?: string; references?: { full?: string } }
  if (typeof body.source_branch !== 'string') throw new Error('GitLab merge request response is missing source_branch')
  if (typeof body.sha !== 'string') throw new Error('GitLab merge request response is missing sha')
  // references.full looks like "group/sub/project!123" — the real path feeds the
  // comment header and View-MR link. Absent on old servers: fall back to project/<id>.
  const full = body.references?.full
  const projectPath = typeof full === 'string' && full.includes('!') ? full.slice(0, full.indexOf('!')) : `project/${config.sourceProjectId}`
  return { sourceBranch: body.source_branch, headSha: body.sha, projectPath }
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
  const { sourceBranch, headSha, projectPath } = await fetchMrDetail(config, deps.fetcher)
  // Push-gate (mirror of the webhook autoRereviewOnPush semantics): the bridge fires
  // on every MR pipeline, so skip when this exact head SHA already completed — and
  // skip new pushes too unless REVIEW_ON_PUSH=1. A re-run then gets the H6 incremental
  // block from history for free. Cache miss (no history) fails open toward running.
  // State comes from GitLab (spec §4.1): the newest bot review comment. The runner
  // cache is per runner and races across concurrent jobs, so it is only a fallback
  // when GitLab cannot be read.
  const history = deps.history ?? { lastCompletedReview }
  let prior: { headSha?: string } | undefined
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
    access: ciAccess(config),
    reviewProfile: config.reviewProfile,
    model: ciModel(ctx, config),
    agentTimeoutMs: config.agentTimeoutMs,
  }
  const runReview = () => ctx.reviewEngine.run({
    projectPath,
    projectId: config.sourceProjectId,
    mrIid: config.mrIid,
    sourceBranch,
    headSha,
    ...(prior?.headSha !== undefined ? { priorHeadSha: prior.headSha } : {}),
    trigger: 'mention',
    mode: config.mode,
    scope: { kind: 'mr' },
    reviewProfile: config.reviewProfile,
  } satisfies ReviewRequest, options)
  const coFetcher = deps.fetcher ?? fetch
  let result: ReviewResult
  if (config.deepRequested) {
    // A deep label is an explicit request: it bypasses the quick push-gate and
    // runs once per head SHA. The label is removed once the request is met.
    let met = false
    if (botUserId !== undefined && await hasCompletedDeepReview(coFetcher, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, mrIid: config.mrIid, botUserId, sha: headSha })) {
      result = { ok: true, summary: `deep review already completed at ${headSha}, skipping`, failures: [], durationMs: 0 }
      met = true
    } else if (await hasRunningEyes(coFetcher, config.gitlabBaseUrl, config.gitlabToken, config.sourceProjectId, config.mrIid, botUserId)) {
      result = { ok: true, summary: 'another review is running — skipping', failures: [], durationMs: 0 }
    } else {
      result = await runReview()
      met = result.ok
    }
    if (met) {
      await removeDeepLabel(coFetcher, { baseUrl: config.gitlabBaseUrl, token: config.gitlabToken, projectId: config.sourceProjectId, mrIid: config.mrIid })
        .catch((err: unknown) => console.warn(`[review] could not remove the deep label: ${err instanceof Error ? err.message : String(err)}`))
    }
  } else if (prior?.headSha === headSha) {
    result = { ok: true, summary: `already reviewed at ${headSha}, skipping`, failures: [], durationMs: 0 }
  } else if (prior !== undefined && !config.rereviewOnPush) {
    result = { ok: true, summary: `new commits since ${prior.headSha} but REVIEW_ON_PUSH is not set, skipping`, failures: [], durationMs: 0 }
  } else if (await hasCompletedReviewForSha(coFetcher, config.gitlabBaseUrl, config.gitlabToken, config.sourceProjectId, config.mrIid, headSha, botUserId)) {
    // Coexistence (CI yields to webhook): the CI history store is invisible to
    // the webhook flow and vice versa, so check the MR itself for a completed
    // review marker of this SHA or an in-flight eyes marker before booting.
    result = { ok: true, summary: `webhook already reviewed ${headSha} — skipping`, failures: [], durationMs: 0 }
  } else if (await hasRunningEyes(coFetcher, config.gitlabBaseUrl, config.gitlabToken, config.sourceProjectId, config.mrIid, botUserId)) {
    result = { ok: true, summary: 'another review is running — skipping', failures: [], durationMs: 0 }
  } else {
    result = await runReview()
  }
  const { writeFile } = deps.writeFile !== undefined ? { writeFile: deps.writeFile } : await import('node:fs/promises')
  // entrypoint.sh cds into deepseek-harness before execing dsh, so a bare relative
  // path would land inside the harness checkout (lost with the container). The
  // entrypoint exports REVIEW_REPORT_DIR=$PWD captured before the cd, so reports land
  // in the CI job's working directory where `artifacts:` picks them up.
  const reportDir = process.env.REVIEW_REPORT_DIR?.trim() || '.'
  const report = { ...result, projectId: config.sourceProjectId, mrIid: config.mrIid, mode: config.mode, generatedAt: new Date().toISOString() }
  await writeFile(join(reportDir, 'review-report.json'), JSON.stringify(report, null, 2), 'utf-8')
  const md = `# Review Report\n\n**Project:** ${config.sourceProjectId} !${config.mrIid}\n**Mode:** ${config.mode}\n**Duration:** ${result.durationMs}ms\n\n${result.summary ?? '(no summary)'}\n${result.failures.length > 0 ? `\nFailures:\n${result.failures.map(f => `- ${f}`).join('\n')}\n` : ''}`
  await writeFile(join(reportDir, 'review-report.md'), md, 'utf-8')
  return result
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
          exit(result.ok ? 0 : 1)
        }
      } catch (err) {
        console.error('maestro-review-ci-trigger:', err instanceof Error ? err.message : String(err))
        ctx.get('appExit')?.(1)
      }
    })()
    return () => {}
  }, 'maestro-review-ci-trigger run')
}
