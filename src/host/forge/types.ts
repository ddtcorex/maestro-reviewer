import type { Context } from '@deepseek-ai/cordis'
import type { ReviewFinding } from '../review-findings-tool.js'

/**
 * What the review engine needs from a code forge, bound to one merge request.
 * GitLab is the one implementation (`forge/gitlab/`); a second forge adds a
 * sibling directory, not branches in the engine.
 */

export interface CompareCommit {
  short_id?: string
  title?: string
}

export interface CompareDiff {
  new_path?: string
}

/** Shape of GitLab's `GET /repository/compare?from=&to=` response (reduced). */
export interface CompareResult {
  commits?: CompareCommit[]
  diffs?: CompareDiff[]
}

export interface ForgeSignals {
  start(): Promise<void>
  finish(outcome: 'completed' | 'failed'): Promise<void>
}

export interface ReviewForge {
  /** Current head SHA, or undefined when it cannot be read (never throws). */
  mrHeadSha(): Promise<string | undefined>
  /** Merge base SHA, or undefined when it cannot be read (never throws). */
  mrBaseSha(): Promise<string | undefined>
  /** What changed between two SHAs, or undefined when it cannot be read (never throws). */
  compare(from: string, to: string): Promise<CompareResult | undefined>
  postNote(body: string): Promise<void>
  replyToDiscussion(discussionId: string, body: string): Promise<void>
  /** Inline threads, replies, or note fallbacks; throws on the first failure. */
  postFindings(findings: ReviewFinding[]): Promise<void>
  /** Running and final markers on the merge request. */
  signals(): ForgeSignals
  /** Mounts the forge's read tools (diffs, threads, inline comments) on a review agent. */
  mountAgentTools(agentCtx: Context, opts: { onDiffTruncated?(): void }): Promise<void>
}
