import type { Context } from '@deepseek-ai/cordis'
import type { FindingSeverity, ReviewFinding } from '../review-findings-tool.js'
import type { DiffHit } from '../redact.js'

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
  old_path?: string
  diff?: string
  deleted_file?: boolean
  /** GitLab collapses a file whose diff exceeds its limits and sends no text. */
  too_large?: boolean
  collapsed?: boolean
}

/** One file of an interdiff the agent tools can serve. */
export interface InterdiffFile { old_path: string; new_path: string; diff: string; deleted_file?: boolean }

/** Shape of GitLab's `GET /repository/compare?from=&to=` response (reduced). */
export interface CompareResult {
  commits?: CompareCommit[]
  diffs?: CompareDiff[]
  /** GitLab gave up computing the compare. */
  compare_timeout?: boolean
}

/** One of the bot's own threads, as the engine needs it to filter replies. */
export interface ThreadState {
  discussionId: string
  path: string
  line: number | null
  /** The opener's severity, when its label can be read. */
  severity?: FindingSeverity
  lastHumanAt?: string
  lastBotAt?: string
  /** The last non-system note was written by a person. */
  lastIsHuman: boolean
}

/** One merge request version: the head it pointed at and when it was created. */
export interface MrVersion { headSha: string; createdAt: string }

export interface ForgeSignals {
  start(): Promise<void>
  finish(outcome: 'completed' | 'failed'): Promise<void>
}

export interface ReviewForge {
  /** Current head SHA, or undefined when it cannot be read (never throws). */
  mrHeadSha(): Promise<string | undefined>
  /** Merge base SHA, or undefined when it cannot be read (never throws). */
  mrBaseSha(): Promise<string | undefined>
  /** Files the review may see after the ignore globs, and the paths they removed; throws when the diff cannot be read. */
  reviewScope(): Promise<{ files: Array<{ path: string; bytes: number }>; skipped: string[]; redacted?: Array<{ path: string; hits: DiffHit[] }>; truncated?: boolean }>
  /** `<code>@<path>` of the bot's open finding threads, so a deterministic finding is not posted twice. */
  openFindingKeys?(): Promise<Set<string>>
  /** A file's text at `ref`, undefined when it does not exist there. */
  readFile?(path: string, ref: string): Promise<string | undefined>
  /** Per finding code, how many of the project's last `window` MRs dismissed it with `/maestro dismiss`. */
  feedback?(window: number): Promise<Map<string, number>>
  /** From now on the agent tools and reviewScope serve these files (an interdiff) instead of the MR diff. */
  restrictToInterdiff?(files: InterdiffFile[]): void
  /** What changed between two SHAs, or undefined when it cannot be read (never throws). */
  compare(from: string, to: string): Promise<CompareResult | undefined>
  /** The bot's own threads with who answered last; optional (no reply filtering without it). */
  ownThreads?(): Promise<ThreadState[]>
  /** Merge request versions in any order (GitLab returns newest first); undefined when they cannot be read. */
  mrVersions?(): Promise<MrVersion[] | undefined>
  postNote(body: string): Promise<void>
  replyToDiscussion(discussionId: string, body: string): Promise<void>
  /** Inline threads, replies, or note fallbacks; throws on the first failure. */
  postFindings(findings: ReviewFinding[]): Promise<void>
  /** Running and final markers on the merge request. */
  signals(): ForgeSignals
  /** Mounts the forge's read tools (diffs, threads, inline comments) on a review agent. */
  mountAgentTools(agentCtx: Context, opts: { onDiffTruncated?(): void; onlyPaths?: string[]; partLabel?: string; readOnly?: boolean }): Promise<void>
}
