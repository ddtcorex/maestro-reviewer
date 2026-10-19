import { mkdir, writeFile } from 'node:fs/promises'
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
import * as SearchTool from './search-tool.js'
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
import { gitlabForge } from './forge/gitlab/index.js'
import { countFindingSeverities } from './severity.js'
import type { ReviewRequest, ReviewResult } from './events.js'
import { lastCompletedReview, recordReviewFinish, recordReviewStart } from './review-history.js'
import { buildIncrementalBlock } from './incremental.js'
import { loadedReviewProfile, type ReviewSkillProfile } from './skills-tool.js'
import { REVIEW_SOURCE_KIND } from './source.js'
import { cloneSourceRepo, defaultRun } from './ci-clone.js'
import {
  agentOptionsForModel, assertSafeBranchName, assertTurnSucceededOrSalvage, auditorOutputFromSession, buildAuditorPrompt,
  buildReviewerScopePrompt, getTurnErrorMessage, isBranchNotFoundError,
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

export interface ReviewEngine { run(payload: ReviewRequest, opts: EngineRunOptions): Promise<ReviewResult> }

export interface AgentRunConfig { gitlab: EngineGitlab; forge: ReviewForge; model: ModelSelection; agentTimeoutMs: number }

/** The reviewer and auditor agent runs; separate so the run flow can be tested without agents. */
export interface EngineAgents {
  reviewer(worktreePath: string | undefined, payload: ReviewRequest, run: AgentRunConfig, reviewProfile?: ReviewSkillProfile, incrementalBlock?: string): Promise<ReviewOutcome>
  auditor(worktreePath: string, payload: ReviewRequest, run: AgentRunConfig, opts?: { staticOnly?: boolean }): Promise<string>
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

export function createEngineAgents(ctx: Context): EngineAgents {
  async function reviewer(worktreePath: string | undefined, payload: ReviewRequest, run: AgentRunConfig, reviewProfile?: ReviewSkillProfile, incrementalBlock?: string): Promise<ReviewOutcome> {
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
            await agentCtx.plugin(ReviewToolPolicy)
            await mountAgentPreset(ctx.agentPresets, agentCtx, 'dsh-maestro-reviewer')
            await run.forge.mountAgentTools(agentCtx, { onDiffTruncated: () => { diffTruncated = true } })
            await agentCtx.plugin(ReviewFindingsTool, { onReport: (findings) => { capturedFindings = findings } })
            // Diff-only runs have no worktree; nothing to search there.
            if (worktreePath !== undefined) {
              await agentCtx.plugin(SearchTool, { rootPath: worktreePath })
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
        let scopePrompt = payload.scope.kind === 'discussion'
          ? buildReviewerScopePrompt({ scopeKind: 'discussion', discussionId: payload.scope.discussionId, path: payload.scope.path, line: payload.scope.line, profileInstruction, lint })
          : buildReviewerScopePrompt({ scopeKind: 'full', mode: payload.mode, profileInstruction, lint })
        if (incrementalBlock !== undefined) scopePrompt = `${incrementalBlock}\n\n${scopePrompt}`
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

        const failures: string[] = []
        let postedNew = 0
        let postedReplies = 0
        for (const finding of capturedFindings) {
          try {
            await run.forge.postFindings([finding])
            if (finding.status === 'new') postedNew++
            else postedReplies++
          } catch (err) {
            const locator = finding.status === 'new' ? `${finding.path}:${finding.line}` : finding.discussionId
            failures.push(`${locator}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return { summary: reviewerSummary(postedNew, postedReplies, diffTruncated), failures, severityCounts: countFindingSeverities(capturedFindings), findings: capturedFindings, models: [primaryOptions.model] }
      } finally {
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
          await agentCtx.plugin(ReviewToolPolicy)
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
      await handle.dispose()
    }
  }

  return { reviewer, auditor }
}

export function createReviewEngine(ctx: Context, agents: EngineAgents = createEngineAgents(ctx)): ReviewEngine {
  async function run(payload: ReviewRequest, opts: EngineRunOptions): Promise<ReviewResult> {
    const t0 = Date.now()
    const { gitlab, access } = opts
    const forge = opts.forge ?? gitlabForge(gitlab, payload)
    const agentRun: AgentRunConfig = { gitlab, forge, model: opts.model, agentTimeoutMs: opts.agentTimeoutMs }
    let reviewStart = Date.now()
    const notify = (status: 'completed' | 'failed', summary?: string) => opts.notify?.(status, summary, Date.now() - reviewStart)
    try {
      const historyId = `${payload.projectId}-${payload.mrIid}-${Date.now()}`
      const currentHeadSha = await forge.mrHeadSha().catch(() => undefined)
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
          incrementalBlock = buildIncrementalBlock(compare, priorHeadSha, currentHeadSha)
        }
      } catch {
        // Optional optimization only — never fail the review for it.
      }
      // Award-emoji acknowledgements only make sense on the MR itself; inline
      // discussion reviews answer in-thread instead.
      const signals = payload.scope.kind === 'mr' ? forge.signals() : undefined
      reviewStart = Date.now()
      await signals?.start()
      const postComment = (body: string) => forge.postNote(body)
      const replyToDiscussion = (discussionId: string, body: string) => forge.replyToDiscussion(discussionId, body)
      const deduped = async (): Promise<ReviewResult> => {
        console.error(`maestro-orchestrator: deduped duplicate in-flight review project=${payload.projectPath} mr=!${payload.mrIid} trigger=${payload.trigger}`)
        await recordReviewFinish(historyId, { status: 'completed', summary: DEDUPED_SUMMARY })
        await signals?.finish('completed')
        return { ok: true, summary: DEDUPED_SUMMARY, failures: [], durationMs: Date.now() - t0 }
      }
      const completed = async (summary: string | undefined): Promise<ReviewResult> => {
        await recordReviewFinish(historyId, { status: 'completed', summary })
        notify('completed', summary)
        await signals?.finish('completed')
        return { ok: true, summary, failures: [], durationMs: Date.now() - t0 }
      }
      const diffOnly = () => runDiffOnlyReview(payload, {
        runReviewer: (p) => agents.reviewer(undefined, p, agentRun, payload.reviewProfile, incrementalBlock),
        postComment,
        replyToDiscussion,
        writeFailedReport,
        gitlabBaseUrl: gitlab.baseUrl,
      } as unknown as DiffOnlyReviewDeps)
      try {
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
          const baseSha = await forge.mrBaseSha()
          await cloneSourceRepo({ fetcher: fetch, run: defaultRun, host: access.host, projectId: payload.projectId, sourceBranch: payload.sourceBranch, headSha: payload.headSha as string, token: gitlab.token, dir: cloneDir, ...(baseSha ? { baseSha } : {}) })
          try {
            const ciEnsureWorktree = async (repoPath: string, branch: string, pid: number, iid: number, suffix?: string): Promise<string> => {
              assertSafeBranchName(branch)
              const wt = join('/tmp', `maestro-mr-${pid}-${iid}${suffix === undefined ? '' : `-${suffix}`}`)
              // No re-fetch: the clone already holds the head, and `fetch --depth` on a
              // shallow repo would cut back the history the base check just deepened.
              await defaultRun('git', ['worktree', 'remove', '--force', wt], repoPath).catch(() => {})
              await defaultRun('git', ['worktree', 'add', '--detach', '--', wt, payload.headSha as string], repoPath)
              return wt
            }
            fullBody = await runReviewAndAudit(payload, {
              localRepoPath: cloneDir,
              ensureWorktree: ciEnsureWorktree,
              removeWorktree,
              runReviewer: (worktreePath, p) => agents.reviewer(worktreePath, p, agentRun, profile, incrementalBlock),
              runAuditor: withAuditorDegrade((worktreePath, p) => agents.auditor(worktreePath, p, agentRun, { staticOnly: true })),
              postComment,
              replyToDiscussion,
              writeFailedReport,
              gitlabBaseUrl: gitlab.baseUrl,
              reviewProfile: profile,
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
              ensureWorktree: access.ensureWorktree,
              removeWorktree: access.removeWorktree,
              ...(access.teardownEnvironment !== undefined ? { teardownEnvironment: access.teardownEnvironment } : {}),
              runReviewer: (worktreePath, p) => agents.reviewer(worktreePath, p, agentRun, profile, incrementalBlock),
              runAuditor: access.auditor === 'static' ? withAuditorDegrade(runAuditor) : runAuditor,
              postComment,
              replyToDiscussion,
              writeFailedReport,
              gitlabBaseUrl: gitlab.baseUrl,
              reviewProfile: profile,
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
        return { ok: false, summary: undefined, failures: [message], durationMs: Date.now() - t0 }
      }
    } catch (err) {
      // Surface failures as a result instead of an unhandled rejection, so both
      // the fire-and-forget webhook path and an awaiting CI caller observe the
      // same outcome.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`maestro-orchestrator: review run failed for MR !${String(payload.mrIid)}:`, err)
      return { ok: false, summary: undefined, failures: [message], durationMs: Date.now() - t0 }
    }
  }
  return { run }
}
