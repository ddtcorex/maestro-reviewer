import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-title'
import * as ReviewFindingsTool from './review-findings-tool.js'
import * as HyvaThemeInspectTool from './hyva-theme-inspect-tool.js'
import * as HyvaCspScanTool from './hyva-csp-scan-tool.js'
import * as LayoutXmlTool from './layout-xml-tool.js'
import * as ModuleCheckTool from './module-check-tool.js'
import * as PhtmlEscapeScanTool from './phtml-escape-scan-tool.js'
import * as ScopeSplitTool from './scope-split-tool.js'
import * as PerfLogStatsTool from './perf-log-stats-tool.js'
import * as ReviewToolPolicy from './tool-policy.js'
import { detectGovardLint } from './govard-lint-detection.js'
import type { ReviewFinding } from './review-findings-tool.js'
import type { ReviewForge } from './forge/types.js'
import type { ReviewMeta } from './review-marker.js'
import { gitlabForge } from './forge/gitlab/index.js'
import { SEVERITY_ORDER, countFindingSeverities, normalizeFindingSeverity } from './severity.js'
import { REPO_CONFIG_PATH, configChangedInMr } from './repo-config.js'
import { secretFindings } from './redact.js'
import { checkDbSchemaWhitelist, detectFrameworkVersions, frameworkContextLine, whitelistFindings } from './composer-context.js'
import { FEEDBACK_WINDOW, MUTE_THRESHOLD, hasOpenThread, mutedCodes } from './review-feedback.js'
import { redactWorktree, redactsWorkspace } from './redact-worktree.js'
import type { FindingSeverity } from './review-findings-tool.js'
import type { ReviewRequest, ReviewResult } from './events.js'
import { lastCompletedReview, recordReviewFinish, recordReviewStart } from './review-history.js'
import { buildIncrementalBlock, planIncremental } from './incremental.js'
import { loadedReviewProfile, type ReviewSkillProfile } from './skills-tool.js'
import { REVIEW_SOURCE_KIND } from './source.js'
import { cloneSourceRepo, defaultRun } from './ci-clone.js'
import { DEFAULT_FANOUT, planChunks, runWithConcurrency, type Chunk, type FanoutSettings } from './chunking.js'
import { mergeFindings } from './merge-findings.js'
import { createStageTimer, sumUsage, usageFromSession, type AgentUsage, type TokenUsage } from './telemetry.js'
import {
  agentOptionsForModel, assertSafeBranchName, assertTurnSucceededOrSalvage, auditorOutputFromSession, buildAuditorPrompt,
  buildNothingReviewableComment, buildReviewerScopePrompt, getTurnErrorMessage, isBranchNotFoundError,
  isUnsupportedReasoningError, mountAgentPreset, reviewerSummary, runDiffOnlyReview, runReviewAndAudit,
  whenIdleWithTimeout, withAuditorDegrade,
  type DiffOnlyReviewDeps, type ReviewAndAuditDeps, type ReviewOutcome,
} from './orchestrator.js'

/**
 * The review engine: one run of a review against an MR, from history and
 * signals through the agents to the posted comment. Callers decide whether a
 * review runs at all and with what configuration (the CI trigger from its
 * environment, the DSH host from user settings and project mappings); the
 * engine never reads either.
 */

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 60_000

/**
 * The CI review worktree. One review runs per job container, and DSH writes
 * the session workspace path into the model-visible runtime context, so a
 * per-MR path would end the provider's cached prefix right there.
 */
export const CI_WORKTREE_PATH = '/tmp/maestro-review-worktree'

export type EnsureWorktree = (localRepoPath: string, sourceBranch: string, projectId: number, mrIid: number, keySuffix?: string) => Promise<string>

/** How the engine reaches the code under review. */
export type CodeAccess =
  /** The GitLab diff only, no checkout. */
  | { kind: 'diff' }
  /** Clone the source at the head SHA from `host` (CI). */
  | { kind: 'clone'; host: string }
  /** A local checkout the caller prepares worktrees from (DSH host). */
  | {
      kind: 'workspace'
      localRepoPath: string
      ensureWorktree: EnsureWorktree
      removeWorktree(worktreePath: string): Promise<void>
      teardownEnvironment?(worktreePath: string): Promise<void>
      /** `static` degrades to reviewer-only when the auditor fails. */
      auditor: 'runtime' | 'static'
    }

export interface EngineGitlab { baseUrl: string; token: string; botUsername: string }

export interface EngineRunOptions {
  gitlab: EngineGitlab
  access: CodeAccess
  /** Profile of checkout runs (clone default `generic`, workspace default `magento2`); diff runs use the payload's. */
  reviewProfile?: ReviewSkillProfile
  model: ModelSelection
  agentTimeoutMs: number
  /** The forge of this MR; defaults to GitLab at `gitlab`. */
  forge?: ReviewForge
  /** Findings of an earlier full review of this head, kept in the metadata of a path-limited review. */
  carryFindings?: ReviewMeta['findings']
  /** Fan-out thresholds and parallelism (default DEFAULT_FANOUT). */
  fanout?: FanoutSettings
  /** Settings from the target branch's .maestro-review.yml (the caller reads and merges them). */
  repo?: { rules?: string[]; minSeverity?: FindingSeverity; language?: string; warnings?: string[] }
  /** Model for high risk fan-out parts; absent = one model for every part. */
  deepModel?: ModelSelection
  /** Paths kept from the model (default DEFAULT_IGNORE_GLOBS); used only by the default GitLab forge. */
  ignoreGlobs?: readonly string[]
  /**
   * Final status of a run, with the review duration measured from the MR
   * signals start. Called once per run, except for a deduped worktree run;
   * a deduped diff run is recorded and notified as completed.
   */
  notify?(status: 'completed' | 'failed', summary?: string, durationMs?: number): void
}

/**
 * A model selection from plain settings values. Callers outside this package
 * use it instead of branding the reasoning effort with their own dsh-llm copy,
 * whose brand TypeScript treats as a different type.
 */
export function toModelSelection(raw: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: raw.provider,
    model: raw.model,
    ...(raw.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(raw.reasoningEffort) }),
  }
}

export interface ReviewEngine {
  run(payload: ReviewRequest, opts: EngineRunOptions): Promise<ReviewResult>
  /** One reviewer-preset agent turn that answers `prompt` with text (MR commands); posts nothing. */
  answer?(payload: ReviewRequest, opts: EngineRunOptions, prompt: string): Promise<string>
}

export interface AgentRunConfig {
  gitlab: EngineGitlab
  forge: ReviewForge
  model: ModelSelection
  agentTimeoutMs: number
  /** Counts every tool call the run's agents attempt; the totals land in ReviewResult.toolCalls. */
  onToolCall: (toolName: string) => void
  /** Findings below it are counted but not posted. */
  minSeverity?: FindingSeverity
  /** Codes the project keeps dismissing: not posted unless blocking. */
  mutedCodes?: ReadonlySet<string>
  /** Framework versions line for the reviewer prompt. */
  frameworkLine?: string
  /** Project rules and comment language for the reviewer prompt. */
  repoRules?: string[]
  language?: string
  /** Records one agent session's token usage (null when the session reported none). */
  onUsage: (agent: AgentUsage['agent'], model: string, usage: TokenUsage | null) => void
}

/** The reviewer and auditor agent runs; separate so the run flow can be tested without agents. */
/** One fan-out part: the reviewer sees only these files and leaves posting to the merge. */
export interface ReviewChunk { label: string; files: string[] }

export interface EngineAgents {
  reviewer(worktreePath: string | undefined, payload: ReviewRequest, run: AgentRunConfig, reviewProfile?: ReviewSkillProfile, incrementalBlock?: string, chunk?: ReviewChunk): Promise<ReviewOutcome>
  auditor(worktreePath: string, payload: ReviewRequest, run: AgentRunConfig, opts?: { staticOnly?: boolean }): Promise<string>
  answer?(payload: ReviewRequest, run: AgentRunConfig, prompt: string): Promise<string>
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  // Best-effort cleanup by design (a failure here must not block or fail the review that
  // already ran) — but a swallowed failure with zero visibility leaves an orphaned worktree
  // in /tmp undetectable, so log it rather than discarding it silently.
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: worktreePath, timeout: GIT_TIMEOUT_MS })
    .catch((err: unknown) => {
      console.error(`maestro-orchestrator: failed to remove worktree ${worktreePath}:`, err)
    })
}

export async function writeFailedReport(mrIid: number, body: string): Promise<void> {
  const dir = join(homedir(), '.dsh', 'maestro', 'failed-reports')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${mrIid}-${Date.now()}.md`), body, 'utf-8')
}

export const DEDUPED_SUMMARY = 'Duplicate in-flight review deduped — see the active run.'

/** First line + bounded excerpt of a posted report, for the history log.
 *  Word-boundary truncation so Telegram never shows half-cut code (`:src="item…`).
 *  If the report starts with the markdown header, strip it — Telegram already has its own header.
 */
export function summarizeReport(body: string | undefined): string | undefined {
  if (body === undefined) return undefined
  const withoutHeader = body.replace(/^## 🤖 Maestro Review[^\n]*\n\s*/, '').trim()
  const cleaned = withoutHeader.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 160) return cleaned
  const cut = cleaned.slice(0, 160)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim()} …`
}

const COMPOSER_MAX_BYTES = 5_000_000

/** Framework versions from composer.lock at the head, else composer.json; never fails the review. */
async function readFrameworkLine(forge: Required<ReviewForge>, ref: string): Promise<string | undefined> {
  const parse = (text: string | undefined) => {
    if (text === undefined || text.length > COMPOSER_MAX_BYTES) return undefined
    try { return JSON.parse(text) as unknown } catch { return undefined }
  }
  try {
    const lock = parse(await forge.readFile('composer.lock', ref))
    const json = lock === undefined ? parse(await forge.readFile('composer.json', ref)) : undefined
    return frameworkContextLine(detectFrameworkVersions(lock, json))
  } catch {
    return undefined
  }
}

/** Posts findings one by one so one bad position never loses the rest. */
export async function postFindingsSequentially(
  forge: Pick<ReviewForge, 'postFindings'>, findings: ReviewFinding[], filter: { minSeverity?: FindingSeverity; muted?: ReadonlySet<string> } = {},
): Promise<{ postedNew: number; postedReplies: number; failures: string[]; belowMinimum: number; muted: number; posted: ReviewFinding[] }> {
  const failures: string[] = []
  let postedNew = 0
  let postedReplies = 0
  const floor = filter.minSeverity === undefined ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(filter.minSeverity)
  const aboveFloor = findings.filter((f) => SEVERITY_ORDER.indexOf(normalizeFindingSeverity(f.severity)) <= floor)
  // Blocking findings are never muted: a project cannot dismiss its way past a blocker.
  const kept = aboveFloor.filter((f) => f.code === undefined || filter.muted?.has(f.code) !== true || normalizeFindingSeverity(f.severity) === 'blocking')
  const posted: ReviewFinding[] = []
  for (const finding of kept) {
    try {
      await forge.postFindings([finding])
      posted.push(finding)
      if (finding.status === 'new') postedNew++
      else postedReplies++
    } catch (err) {
      const locator = finding.status === 'new' ? `${finding.path}:${finding.line}` : finding.discussionId
      failures.push(`${locator}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { postedNew, postedReplies, failures, belowMinimum: findings.length - aboveFloor.length, muted: aboveFloor.length - kept.length, posted }
}

/** Summary line, plus the count of findings below the project's minimum severity. */
function summaryWithFloor(base: string, belowMinimum: number, minSeverity?: FindingSeverity): string {
  return belowMinimum > 0 && minSeverity !== undefined ? `${base} ${belowMinimum} finding(s) below ${minSeverity} were counted but not posted.` : base
}

export function createEngineAgents(ctx: Context): EngineAgents {
  async function reviewer(worktreePath: string | undefined, payload: ReviewRequest, run: AgentRunConfig, reviewProfile?: ReviewSkillProfile, incrementalBlock?: string, chunk?: ReviewChunk): Promise<ReviewOutcome> {
    // MR base SHA feeds the govard diff-scope lint command; undefined omits the
    // lint rule instead of sending a wasted govard invocation.
    const lintDefaultBase = await run.forge.mrBaseSha()
    const primaryOptions = agentOptionsForModel(run.model)
    const fallbackOptions: ModelSelection = { provider: primaryOptions.provider, model: primaryOptions.model }
    let lastHandle: AgentHandle | undefined
    const runOnce = async (agentOptions: ModelSelection): Promise<ReviewOutcome> => {
      let capturedFindings: ReviewFinding[] = []
      let diffTruncated = false
      let handle: AgentHandle | undefined
      try {
        handle = await ctx.agents.create({
          sessionId: SessionId(`maestro-reviewer-${payload.mrIid}-${Date.now()}`),
          meta: { cwd: worktreePath ?? tmpdir() },
          agentOptions,
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, { current: agentOptions, assembled: undefined })
            await agentCtx.plugin(ReviewToolPolicy, { onToolCall: run.onToolCall })
            await mountAgentPreset(ctx.agentPresets, agentCtx, 'dsh-maestro-reviewer')
            await run.forge.mountAgentTools(agentCtx, { onDiffTruncated: () => { diffTruncated = true }, ...(chunk !== undefined ? { onlyPaths: chunk.files, partLabel: chunk.label } : {}) })
            await agentCtx.plugin(ReviewFindingsTool, { onReport: (findings) => { capturedFindings = findings } })
            // Diff-only runs have no worktree; nothing to search there.
            if (worktreePath !== undefined) {
              await agentCtx.plugin(HyvaThemeInspectTool, { rootPath: worktreePath })
              await agentCtx.plugin(HyvaCspScanTool, { rootPath: worktreePath })
              await agentCtx.plugin(LayoutXmlTool, { rootPath: worktreePath })
              await agentCtx.plugin(ModuleCheckTool, { rootPath: worktreePath })
              await agentCtx.plugin(PhtmlEscapeScanTool, { rootPath: worktreePath })
              await agentCtx.plugin(ScopeSplitTool, { rootPath: worktreePath })
              await agentCtx.plugin(PerfLogStatsTool, { rootPath: worktreePath })
            }
          },
        })
      } catch (err) {
        lastHandle = handle
        throw new Error(`failed to create reviewer agent: ${err instanceof Error ? err.message : String(err)}`)
      }
      lastHandle = handle
      ctx.sessionTitle.rename(handle.agent.session, `Maestro Reviewer — MR !${payload.mrIid} (${payload.projectPath})`)
      try {
        const profileInstruction = reviewProfile === undefined
          ? 'This is a diff-only review with no local checkout or Magento environment. Do not claim that tests, static analysis, or Magento runtime validation ran. '
          : `Call maestro_load_review_profile with {"profile":"${reviewProfile}"} before examining code. `
        // The lint runs as a govard CLI command through the bash tool. Only
        // demand it when the registry resolves bash for this agent and govard
        // is on PATH, and carry the MR base sha in the command.
        const lint = worktreePath !== undefined && lintDefaultBase && detectGovardLint(ctx, handle.agent)
          ? { worktreePath, base: lintDefaultBase }
          : null
        const scopePrompt = payload.scope.kind === 'discussion'
          ? buildReviewerScopePrompt({ scopeKind: 'discussion', discussionId: payload.scope.discussionId, path: payload.scope.path, line: payload.scope.line, profileInstruction, lint })
          : buildReviewerScopePrompt({ scopeKind: 'full', mode: payload.mode, profileInstruction, lint, ...(incrementalBlock !== undefined ? { incrementalBlock } : {}), ...(chunk !== undefined ? { part: chunk } : {}), ...(run.repoRules !== undefined ? { repoRules: run.repoRules } : {}), ...(run.language !== undefined ? { language: run.language } : {}), ...(run.frameworkLine !== undefined ? { frameworkLine: run.frameworkLine } : {}) })
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: scopePrompt }],
          source: { kind: REVIEW_SOURCE_KIND },
        }))
        await whenIdleWithTimeout(handle, run.agentTimeoutMs)
        assertTurnSucceededOrSalvage(handle, capturedFindings.length > 0, 'reviewer')
        if (reviewProfile !== undefined && loadedReviewProfile(handle.agent) !== reviewProfile) {
          throw new Error(`reviewer did not successfully load the required ${reviewProfile} review skill profile; no findings were posted`)
        }

        // An inline command is a request to discuss one existing thread, not a
        // license to fan out new threads across the MR. The report tool remains
        // useful as a structured response channel, but its findings are folded
        // into the one reply made by runReviewAndAudit below.
        if (payload.scope.kind === 'discussion') {
          const response = capturedFindings.length === 0
            ? 'No actionable issue found for the requested line.'
            : capturedFindings.map((finding) => finding.body).join('\n\n')
          return { summary: response, failures: [] }
        }

        if (chunk !== undefined) return { summary: '', failures: [], findings: capturedFindings, models: [primaryOptions.model], deferredPost: true }
        const { postedNew, postedReplies, failures, belowMinimum, posted } = await postFindingsSequentially(run.forge, capturedFindings, { minSeverity: run.minSeverity, muted: run.mutedCodes })
        return {
          postedFindings: posted,
          // A diff cut at MAX_DIFF_FILES left files unseen: the next re-review must be full.
          ...(diffTruncated ? { partial: true } : {}), summary: summaryWithFloor(reviewerSummary(postedNew, postedReplies, diffTruncated), belowMinimum, run.minSeverity), failures, severityCounts: countFindingSeverities(capturedFindings), findings: capturedFindings, models: [primaryOptions.model] }
      } finally {
        run.onUsage('reviewer', agentOptions.model, usageFromSession(handle.agent.session))
        await handle.dispose()
      }
    }
    try {
      return await runOnce(primaryOptions)
    } catch (err) {
      const turnMsg = getTurnErrorMessage(lastHandle)
      const isTurnUnsupported = turnMsg !== undefined && (turnMsg.includes('does not support reasoning effort') || turnMsg.includes('UNSUPPORTED_REASONING_EFFORT'))
      const isUnsupported = isUnsupportedReasoningError(err) || isTurnUnsupported
      if (primaryOptions.reasoningEffort !== undefined && isUnsupported) {
        const originalMsg = turnMsg ?? (err instanceof Error ? err.message : String(err))
        try {
          const result = await runOnce(fallbackOptions)
          console.warn(`maestro-orchestrator: Review model ${primaryOptions.provider}/${primaryOptions.model} with reasoningEffort "${String(primaryOptions.reasoningEffort)}" is unsupported; retried without reasoningEffort and succeeded`)
          return result
        } catch (retryErr) {
          const retryMsg = getTurnErrorMessage(lastHandle) ?? (retryErr instanceof Error ? retryErr.message : String(retryErr))
          throw new Error(`Review model ${primaryOptions.provider}/${primaryOptions.model} with reasoningEffort "${String(primaryOptions.reasoningEffort)}" is unsupported (${originalMsg}). Retried without reasoningEffort but still failed: ${retryMsg}. Remove reasoningEffort in Settings → Maestro → Review model or choose a reasoning-capable model.`)
        }
      }
      if (err instanceof Error && err.message.includes('did not successfully load the required')) {
        const effort = String(primaryOptions.reasoningEffort)
        const hint = primaryOptions.reasoningEffort === undefined
          ? `${err.message}. Check that maestro-skills are installed and DSH was restarted after install.`
          : `${err.message}. Model ${primaryOptions.provider}/${primaryOptions.model} with reasoningEffort "${effort}" may be unsupported — check Settings → Maestro → Review model. Original turn likely failed with UNSUPPORTED_REASONING_EFFORT — see session.jsonl.zstd turn/end.`
        throw new Error(hint)
      }
      throw err
    }
  }

  async function auditor(worktreePath: string, payload: ReviewRequest, run: AgentRunConfig, opts?: { staticOnly?: boolean }): Promise<string> {
    let handle: AgentHandle
    const agentOptions = agentOptionsForModel(run.model)
    try {
      handle = await ctx.agents.create({
        sessionId: SessionId(`maestro-auditor-${payload.mrIid}-${Date.now()}`),
        meta: { cwd: worktreePath },
        agentOptions,
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, { current: agentOptions, assembled: undefined })
          await agentCtx.plugin(ReviewToolPolicy, { onToolCall: run.onToolCall })
          await mountAgentPreset(ctx.agentPresets, agentCtx, 'dsh-maestro-auditor')
          await run.forge.mountAgentTools(agentCtx, {})
        },
      })
    } catch (err) {
      throw new Error(`failed to create auditor agent: ${err instanceof Error ? err.message : String(err)}`)
    }
    ctx.sessionTitle.rename(handle.agent.session, `Maestro Auditor — MR !${payload.mrIid} (${payload.projectPath})`)
    try {
      const prompt = buildAuditorPrompt({ staticOnly: opts?.staticOnly === true, cliAvailable: detectGovardLint(ctx, handle.agent) })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: REVIEW_SOURCE_KIND } }))
      await whenIdleWithTimeout(handle, run.agentTimeoutMs)
      const output = auditorOutputFromSession(handle.agent.session)
      const text = output.map(block => ('text' in block ? block.text : '')).join('')
      assertTurnSucceededOrSalvage(handle, text.trim() !== '', 'auditor')
      return `## Maestro Performance Audit\n\n${text}`
    } finally {
      run.onUsage('auditor', agentOptions.model, usageFromSession(handle.agent.session))
      await handle.dispose()
    }
  }

  async function answer(payload: ReviewRequest, run: AgentRunConfig, prompt: string): Promise<string> {
    const agentOptions = agentOptionsForModel(run.model)
    // Its own workspace: the diff tool spills there, never into a shared /tmp.
    const answerDir = await mkdtemp(join(tmpdir(), 'maestro-answer-'))
    let handle: AgentHandle
    try {
      handle = await ctx.agents.create({
        sessionId: SessionId(`maestro-answer-${payload.mrIid}-${Date.now()}`),
        meta: { cwd: answerDir },
        agentOptions,
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, { current: agentOptions, assembled: undefined })
          await agentCtx.plugin(ReviewToolPolicy, { onToolCall: run.onToolCall })
          await mountAgentPreset(ctx.agentPresets, agentCtx, 'dsh-maestro-reviewer')
          // Read tools only: an answer is text the caller posts; the agent never writes to the MR.
          await run.forge.mountAgentTools(agentCtx, { readOnly: true })
        },
      })
    } catch (err) {
      throw new Error(`failed to create the answer agent: ${err instanceof Error ? err.message : String(err)}`)
    }
    ctx.sessionTitle.rename(handle.agent.session, `Maestro Answer — MR !${payload.mrIid} (${payload.projectPath})`)
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: REVIEW_SOURCE_KIND } }))
      await whenIdleWithTimeout(handle, run.agentTimeoutMs)
      const text = auditorOutputFromSession(handle.agent.session).map((block) => ('text' in block ? block.text : '')).join('').trim()
      assertTurnSucceededOrSalvage(handle, text !== '', 'answer')
      return text
    } finally {
      run.onUsage('reviewer', agentOptions.model, usageFromSession(handle.agent.session))
      await handle.dispose()
      await rm(answerDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { reviewer, auditor, answer }
}

export function createReviewEngine(ctx: Context, agents: EngineAgents = createEngineAgents(ctx)): ReviewEngine {
  async function run(payload: ReviewRequest, opts: EngineRunOptions): Promise<ReviewResult> {
    const t0 = Date.now()
    const { gitlab, access } = opts
    const timer = createStageTimer()
    // Posting runs inside the agent stage (findings after each reviewer turn,
    // the comment after all agents), so it is timed per call and moved to post.
    let postMs = 0
    const timedPost = async <T>(call: () => Promise<T>): Promise<T> => {
      const start = Date.now()
      try { return await call() } finally { postMs += Date.now() - start }
    }
    const rawForge = opts.forge ?? gitlabForge(gitlab, payload, { ...(opts.ignoreGlobs !== undefined ? { ignoreGlobs: opts.ignoreGlobs } : {}), ...(payload.pathPrefix !== undefined ? { pathPrefix: payload.pathPrefix } : {}) })
    const forge: Required<ReviewForge> = {
      mrHeadSha: () => rawForge.mrHeadSha(),
      mrBaseSha: () => rawForge.mrBaseSha(),
      reviewScope: () => rawForge.reviewScope(),
      // Optional forge members fall back to "unsupported": no interdiff, no feedback, no file reads.
      restrictToInterdiff: (files) => { rawForge.restrictToInterdiff?.(files) },
      feedback: (window) => rawForge.feedback?.(window) ?? Promise.resolve(new Map<string, number>()),
      readFile: (path, ref) => rawForge.readFile?.(path, ref) ?? Promise.resolve(undefined),
      openFindingKeys: () => rawForge.openFindingKeys?.() ?? Promise.resolve(new Set<string>()),
      compare: (from, to) => rawForge.compare(from, to),
      postNote: (body) => timedPost(() => rawForge.postNote(body)),
      replyToDiscussion: (id, body) => timedPost(() => rawForge.replyToDiscussion(id, body)),
      postFindings: (findings) => timedPost(() => rawForge.postFindings(findings)),
      signals: () => rawForge.signals(),
      mountAgentTools: (agentCtx, o) => rawForge.mountAgentTools(agentCtx, o),
    }
    const toolCallCounts = new Map<string, number>()
    const toolCalls = () => Object.fromEntries([...toolCallCounts].sort(([a], [b]) => a.localeCompare(b)))
    const usages: AgentUsage[] = []
    const agentRun: AgentRunConfig = {
      gitlab, forge, model: opts.model, agentTimeoutMs: opts.agentTimeoutMs,
      onToolCall: (toolName) => { toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1) },
      onUsage: (agent, model, usage) => { usages.push({ agent, model, usage }) },
      ...(opts.repo?.minSeverity !== undefined ? { minSeverity: opts.repo.minSeverity } : {}),
      ...(opts.repo?.rules !== undefined && opts.repo.rules.length > 0 ? { repoRules: opts.repo.rules } : {}),
      ...(opts.repo?.language !== undefined ? { language: opts.repo.language } : {}),
    }
    const notices: string[] = [...(opts.repo?.warnings ?? [])]
    let agentsStarted = false
    let runFindings: ReviewFinding[] | undefined
    let runPartial = false
    const deterministicPosted: ReviewFinding[] = []
    /** Closes the stage timeline once and returns the run's telemetry. */
    const telemetry = () => {
      if (agentsStarted) {
        agentsStarted = false
        timer.mark('agent', postMs)
        timer.add('post', postMs)
      }
      return { toolCalls: toolCalls(), stages: timer.toJSON(), usage: [...usages], ...(runFindings !== undefined ? { findings: runFindings } : {}), ...(runPartial ? { partial: true } : {}) }
    }
    const usageTotal = () => sumUsage(usages.map((u) => u.usage))
    let reviewStart = Date.now()
    const notify = (status: 'completed' | 'failed', summary?: string) => opts.notify?.(status, summary, Date.now() - reviewStart)
    try {
      const historyId = `${payload.projectId}-${payload.mrIid}-${Date.now()}`
      const currentHeadSha = await forge.mrHeadSha().catch(() => undefined)
      const currentBaseSha = await forge.mrBaseSha().catch(() => undefined)
      await recordReviewStart({
        id: historyId,
        projectId: payload.projectId,
        projectPath: payload.projectPath,
        mrIid: payload.mrIid,
        mode: payload.mode,
        scope: payload.scope.kind,
        trigger: payload.trigger,
        startedAt: Date.now(),
        headSha: currentHeadSha,
      })
      // H6 incremental context: what changed since the last completed review on this MR.
      let incrementalBlock: string | undefined
      try {
        // CI hands over the prior head it read from GitLab; the history store is runner-local there.
        const priorHeadSha = payload.priorHeadSha ?? (await lastCompletedReview(payload.projectId, payload.mrIid))?.headSha
        if (priorHeadSha !== undefined && currentHeadSha !== undefined && priorHeadSha !== currentHeadSha) {
          const compare = await forge.compare(priorHeadSha, currentHeadSha)
          // A deep request asks for the whole MR, never only what changed since a quick pass.
          const plan = payload.scope.kind === 'mr' && payload.mode === 'quick'
            ? planIncremental({ headSha: priorHeadSha, ...(payload.priorBaseSha !== undefined ? { baseSha: payload.priorBaseSha } : {}), ...(payload.priorPartial === true ? { partial: true } : {}) }, { headSha: currentHeadSha, ...(currentBaseSha !== undefined ? { baseSha: currentBaseSha } : {}) }, compare)
            : undefined
          if (plan?.kind === 'interdiff' && rawForge.restrictToInterdiff !== undefined) {
            forge.restrictToInterdiff(plan.files)
            incrementalBlock = buildIncrementalBlock(compare, priorHeadSha, currentHeadSha, { interdiff: true })
          } else if (plan?.kind === 'full' && plan.reason === 'base changed') {
            // A compare across a rebase mixes in the target's changes: review it all, no hint.
            console.log(`[review] full review: ${plan.reason} since ${priorHeadSha.slice(0, 12)}`)
          } else {
            if (plan !== undefined) console.log(`[review] full review: ${plan.kind === 'full' ? plan.reason : 'this forge serves no interdiff'} since ${priorHeadSha.slice(0, 12)}`)
            incrementalBlock = buildIncrementalBlock(compare, priorHeadSha, currentHeadSha)
          }
        }
      } catch {
        // Optional optimization only — never fail the review for it.
      }
      // Award-emoji acknowledgements only make sense on the MR itself; inline
      // discussion reviews answer in-thread instead.
      const signals = payload.scope.kind === 'mr' ? forge.signals() : undefined
      reviewStart = Date.now()
      await signals?.start()
      timer.mark('fetch')
      agentsStarted = true
      const postComment = (body: string) => forge.postNote(body)
      const replyToDiscussion = (discussionId: string, body: string) => forge.replyToDiscussion(discussionId, body)
      const deduped = async (): Promise<ReviewResult> => {
        console.error(`maestro-orchestrator: deduped duplicate in-flight review project=${payload.projectPath} mr=!${payload.mrIid} trigger=${payload.trigger}`)
        await recordReviewFinish(historyId, { status: 'completed', summary: DEDUPED_SUMMARY })
        await signals?.finish('completed')
        return { ok: true, summary: DEDUPED_SUMMARY, failures: [], durationMs: Date.now() - t0, ...telemetry() }
      }
      const completed = async (summary: string | undefined): Promise<ReviewResult> => {
        await recordReviewFinish(historyId, { status: 'completed', summary })
        notify('completed', summary)
        await signals?.finish('completed')
        return { ok: true, summary, failures: [], durationMs: Date.now() - t0, ...telemetry() }
      }
      let scopeFiles: Array<{ path: string; bytes: number }> | undefined
      /** The MR diff hit GitLab's file cap: files beyond it are never reviewed. */
      let scopeTruncated = false
      // Opt-in: only a caller that passes thresholds (the CI trigger) fans out.
      const fanout = opts.fanout
      /** One reviewer run, or parallel parts for a large MR whose findings are merged and posted once. */
      const review = async (worktreePath: string | undefined, p: ReviewRequest, profile?: ReviewSkillProfile): Promise<ReviewOutcome> => {
        const outcome = await reviewParts(worktreePath, p, profile)
        runFindings = [...(outcome.postedFindings ?? outcome.findings ?? []), ...deterministicPosted]
        runPartial = outcome.partial === true
        return outcome
      }
      const reviewParts = async (worktreePath: string | undefined, p: ReviewRequest, profile?: ReviewSkillProfile): Promise<ReviewOutcome> => {
        const chunks = fanout !== undefined && p.scope.kind === 'mr' && scopeFiles !== undefined ? planChunks(scopeFiles, fanout) : []
        if (chunks.length <= 1) return agents.reviewer(worktreePath, p, agentRun, profile, incrementalBlock)
        const runFor = (c: Chunk): AgentRunConfig => c.risk === 'high' && opts.deepModel !== undefined ? { ...agentRun, model: opts.deepModel } : agentRun
        const settled = await runWithConcurrency(chunks.map((c) => () => agents.reviewer(worktreePath, p, runFor(c), profile, incrementalBlock, { label: c.id, files: c.files })), fanout?.concurrency ?? DEFAULT_FANOUT.concurrency)
        const done = settled.flatMap((r) => r.status === 'fulfilled' ? [r.value] : [])
        const failed = settled.flatMap((r, i) => r.status === 'rejected' ? [{ chunk: chunks[i], reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }] : [])
        if (done.length === 0) throw new Error(`every review part failed: ${[...new Set(failed.map((f) => f.reason))].join('; ')}`)
        const findings = mergeFindings(done.map((o) => o.findings ?? []))
        const posted = await postFindingsSequentially(forge, findings, { minSeverity: agentRun.minSeverity, muted: agentRun.mutedCodes })
        const parts = [`Reviewed in ${chunks.length} parallel parts.`, ...(scopeTruncated ? ['The diff reached the file cap: files beyond it were not reviewed.'] : []), ...failed.map((f) => `Part ${f.chunk.id} (${f.chunk.files.length} files) failed: ${f.reason}; its files were not reviewed.`)]
        return {
          summary: summaryWithFloor(`${reviewerSummary(posted.postedNew, posted.postedReplies, false)} ${parts.join(' ')}`, posted.belowMinimum, agentRun.minSeverity),
          failures: [...done.flatMap((o) => o.failures), ...posted.failures],
          severityCounts: countFindingSeverities(findings),
          findings,
          postedFindings: posted.posted,
          models: [...new Set(done.flatMap((o) => o.models ?? []))],
          // The count covers failed parts only, so a capped diff leaves it out (it would undercount).
          ...(failed.length > 0 || scopeTruncated ? { partial: true, ...(scopeTruncated ? {} : { unreviewed: failed.reduce((n, f) => n + f.chunk.files.length, 0) }) } : {}),
        }
      }
      const diffOnly = () => runDiffOnlyReview(payload, {
        runReviewer: (p) => review(undefined, p, payload.reviewProfile),
        postComment,
        replyToDiscussion,
        writeFailedReport,
        gitlabBaseUrl: gitlab.baseUrl,
        usageTotal,
        skippedFiles,
        notices,
        get muted() { return mutedList },
        pathLimited: payload.pathPrefix !== undefined,
        ...(opts.carryFindings !== undefined ? { carryFindings: opts.carryFindings } : {}),
        baseSha: currentBaseSha,
      } as unknown as DiffOnlyReviewDeps)
      let skippedFiles: string[] | undefined
      let mutedList: string[] | undefined
      /** Engine-made findings: never twice while the same code and path has an open thread. */
      const postDeterministic = async (found: ReviewFinding[]): Promise<void> => {
        const open = await forge.openFindingKeys().catch(() => new Set<string>())
        const fresh = found.filter((f) => !hasOpenThread(f, open))
        const r = await postFindingsSequentially(forge, fresh).catch(() => undefined)
        if (r !== undefined) deterministicPosted.push(...r.posted)
      }
      try {
        if (payload.scope.kind === 'mr') {
          // An unreadable diff is left to the agents, which report it themselves.
          const scope = await forge.reviewScope().catch(() => undefined)
          timer.mark('fetch')
          if (scope !== undefined && scope.files.length === 0) {
            const body = buildNothingReviewableComment(payload, { gitlabBaseUrl: gitlab.baseUrl, skipped: scope.skipped, ...(currentBaseSha !== undefined ? { baseSha: currentBaseSha } : {}) })
            agentsStarted = false
            await forge.postNote(body)
            timer.add('post', postMs)
            return await completed(summarizeReport(body))
          }
          skippedFiles = scope?.skipped
          scopeFiles = scope?.files
          scopeTruncated = scope?.truncated === true
          // Feedback is optional context: an unreadable history never blocks the review.
          const muted = mutedCodes(await Promise.resolve().then(() => forge.feedback(FEEDBACK_WINDOW)).catch(() => new Map<string, number>()))
          if (muted.size > 0) {
            agentRun.mutedCodes = muted
            mutedList = [...muted].sort()
            notices.push(`Muted for this project (dismissed with /maestro dismiss in at least ${MUTE_THRESHOLD} of the last ${FEEDBACK_WINDOW} MRs): ${mutedList.map((c) => `\`${c}\``).join(', ')}. Findings with these codes are not posted unless blocking.`)
          }
          const redacted = scope?.redacted ?? []
          const redactedCount = redacted.reduce((n, f) => n + f.hits.length, 0)
          if (redactedCount > 0) {
            notices.push(`${redactedCount} values redacted before review (secrets and personal data): the model saw placeholders, never the values.`)
            await postDeterministic(secretFindings(redacted))
          }
          if (payload.headSha !== undefined) {
            agentRun.frameworkLine = await readFrameworkLine(forge, payload.headSha)
            if (agentRun.frameworkLine === undefined) delete agentRun.frameworkLine
          }
          if (scope !== undefined) {
            const missing = whitelistFindings(checkDbSchemaWhitelist(scope.files.map((f) => f.path)))
            if (missing.length > 0) await postDeterministic(missing)
          }
          // Only a caller that read the settings (the CI trigger) can say which ones this review used.
          if (opts.repo !== undefined && scope !== undefined && configChangedInMr(scope.files.map((f) => f.path))) {
            // The file is read from the target branch: a change here only applies after merge.
            notices.push(`This MR changes ${REPO_CONFIG_PATH}: the change applies after merge; this review used the target branch's settings.`)
            await postDeterministic([{
              status: 'new', path: REPO_CONFIG_PATH, line: 1, severity: 'minor', code: 'CFG-CHANGED', category: 'config',
              body: `This MR changes the review settings in ${REPO_CONFIG_PATH}. They apply after merge; check that the change does not hide findings (ignore globs, minSeverity).`,
            }])
          }
        }
        if (access.kind === 'diff') {
          const diffBody = await diffOnly()
          // A deduped diff run returns '' and is still recorded as completed (unchanged behaviour).
          return await completed(summarizeReport(diffBody))
        }
        let fullBody: string
        if (access.kind === 'clone') {
          // CI checkout: clone the source at the head SHA and reuse the
          // worktree machinery; quick stays reviewer-only (runReviewAndAudit's
          // shouldAudit). No govard/vendor linking (plain fetch + worktree).
          const profile = opts.reviewProfile ?? 'generic'
          const cloneDir = join('/tmp', `maestro-ci-src-${payload.projectId}-${payload.mrIid}`)
          // D3: make the MR merge base reachable from the head in the shallow clone.
          const baseSha = currentBaseSha
          timer.mark('fetch')
          await cloneSourceRepo({ fetcher: fetch, run: defaultRun, host: access.host, projectId: payload.projectId, sourceBranch: payload.sourceBranch, headSha: payload.headSha as string, token: gitlab.token, dir: cloneDir, ...(baseSha ? { baseSha } : {}) })
          timer.mark('clone')
          try {
            const ciEnsureWorktree = async (repoPath: string, branch: string): Promise<string> => {
              assertSafeBranchName(branch)
              const wt = CI_WORKTREE_PATH
              // No re-fetch: the clone already holds the head, and `fetch --depth` on a
              // shallow repo would cut back the history the base check just deepened.
              await defaultRun('git', ['worktree', 'remove', '--force', wt], repoPath).catch(() => {})
              await defaultRun('git', ['worktree', 'add', '--detach', '--', wt, payload.headSha as string], repoPath)
              // The agents' file tools read this checkout: redact it before any agent starts.
              const r = await redactWorktree(wt)
              if (r.hits > 0) console.log(`[review] redacted ${r.hits} value(s) in ${r.files} file(s) of the checkout`)
              return wt
            }
            fullBody = await runReviewAndAudit(payload, {
              localRepoPath: cloneDir,
              ensureWorktree: ciEnsureWorktree,
              removeWorktree,
              runReviewer: (worktreePath, p) => review(worktreePath, p, profile),
              runAuditor: withAuditorDegrade((worktreePath, p) => agents.auditor(worktreePath, p, agentRun, { staticOnly: true })),
              postComment,
              replyToDiscussion,
              writeFailedReport,
              gitlabBaseUrl: gitlab.baseUrl,
              reviewProfile: profile,
              usageTotal,
              skippedFiles,
              notices,
              get muted() { return mutedList },
              pathLimited: payload.pathPrefix !== undefined,
              ...(opts.carryFindings !== undefined ? { carryFindings: opts.carryFindings } : {}),
              baseSha: currentBaseSha,
            } as unknown as ReviewAndAuditDeps)
          } finally {
            await defaultRun('rm', ['-rf', cloneDir]).catch(() => {})
          }
        } else {
          const profile = opts.reviewProfile ?? 'magento2'
          const runAuditor = (worktreePath: string, p: ReviewRequest) => agents.auditor(worktreePath, p, agentRun, access.auditor === 'static' ? { staticOnly: true } : undefined)
          try {
            fullBody = await runReviewAndAudit(payload, {
              localRepoPath: access.localRepoPath,
              // Redact the checkout the agents read, unless a runtime audit (env up, tests) needs the real files.
              ensureWorktree: async (repoPath: string, branch: string, pid: number, iid: number, suffix?: string) => {
                const wt = await access.ensureWorktree(repoPath, branch, pid, iid, suffix)
                if (redactsWorkspace(payload, access.auditor)) {
                  // Fail closed, as in CI: no agent reads a worktree that could not be redacted.
                  const r = await redactWorktree(wt)
                  if (r.hits > 0) console.log(`[review] redacted ${r.hits} value(s) in ${r.files} file(s) of the worktree`)
                }
                return wt
              },
              removeWorktree: access.removeWorktree,
              ...(access.teardownEnvironment !== undefined ? { teardownEnvironment: access.teardownEnvironment } : {}),
              runReviewer: (worktreePath, p) => review(worktreePath, p, profile),
              runAuditor: access.auditor === 'static' ? withAuditorDegrade(runAuditor) : runAuditor,
              postComment,
              replyToDiscussion,
              writeFailedReport,
              gitlabBaseUrl: gitlab.baseUrl,
              reviewProfile: profile,
              usageTotal,
              skippedFiles,
              notices,
              get muted() { return mutedList },
              pathLimited: payload.pathPrefix !== undefined,
              ...(opts.carryFindings !== undefined ? { carryFindings: opts.carryFindings } : {}),
              baseSha: currentBaseSha,
            } as unknown as ReviewAndAuditDeps)
          } catch (err) {
            const isBranchNotFound = (err as { code?: string })?.code === 'BRANCH_NOT_FOUND' || isBranchNotFoundError(err)
            if (!isBranchNotFound) throw err
            const diffBody = await diffOnly()
            if (diffBody === '') return await deduped()
            const branchNote = `fallback diff-only: branch ${payload.sourceBranch} not found on origin — ${summarizeReport(diffBody) ?? ''}`.trim()
            return await completed(branchNote)
          }
        }
        if (fullBody === '') return await deduped()
        return await completed(summarizeReport(fullBody))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await recordReviewFinish(historyId, { status: 'failed', error: message }).catch(() => {})
        notify('failed', message)
        await signals?.finish('failed')
        return { ok: false, summary: undefined, failures: [message], durationMs: Date.now() - t0, ...telemetry() }
      }
    } catch (err) {
      // Surface failures as a result instead of an unhandled rejection, so both
      // the fire-and-forget webhook path and an awaiting CI caller observe the
      // same outcome.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`maestro-orchestrator: review run failed for MR !${String(payload.mrIid)}:`, err)
      return { ok: false, summary: undefined, failures: [message], durationMs: Date.now() - t0, ...telemetry() }
    }
  }
  async function answer(payload: ReviewRequest, opts: EngineRunOptions, prompt: string): Promise<string> {
    if (agents.answer === undefined) throw new Error('this engine has no answer agent')
    const forge = opts.forge ?? gitlabForge(opts.gitlab, payload, opts.ignoreGlobs !== undefined ? { ignoreGlobs: opts.ignoreGlobs } : {})
    return agents.answer(payload, {
      gitlab: opts.gitlab, forge, model: opts.model, agentTimeoutMs: opts.agentTimeoutMs,
      onToolCall: () => {}, onUsage: () => {},
    }, prompt)
  }
  return { run, answer }
}
