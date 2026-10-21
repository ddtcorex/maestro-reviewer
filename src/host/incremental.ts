import type { CompareResult, InterdiffFile } from './forge/types.js'
const COMMIT_LIST_CAP = 20

/**
 * Build the incremental-review context block for a re-review: everything that
 * changed since the last completed Maestro pass on this MR. Returns undefined
 * when there is nothing new to say (no prior sha, same sha, or empty compare)
 * so callers can skip the API round-trip cost of the block.
 */
export function buildIncrementalBlock(
  compare: CompareResult | undefined,
  sinceSha: string | undefined,
  nowSha: string | undefined,
  opts: { interdiff?: boolean } = {},
): string | undefined {
  if (sinceSha === undefined || nowSha === undefined || sinceSha === nowSha) return undefined
  if (compare === undefined) return undefined
  const commits = compare.commits ?? []
  const diffs = compare.diffs ?? []
  if (commits.length === 0 && diffs.length === 0) return undefined

  const lines: string[] = [
    opts.interdiff === true
      ? `This MR was reviewed before (at ${sinceSha.slice(0, 12)}). The diff tools now show only what changed since then: review those changes, and re-check only open threads whose location falls inside them. Commits since then:`
      : `This MR was reviewed before (at ${sinceSha.slice(0, 12)}). The following is what changed since then — focus your review on these files and commits, and re-check only open threads whose location falls inside them:`,
  ]
  const shown = commits.slice(0, COMMIT_LIST_CAP)
  for (const commit of shown) {
    const title = commit.title?.replace(/\s+/g, ' ').trim() ?? ''
    lines.push(`- ${commit.short_id ? `${commit.short_id.slice(0, 8)} ` : ''}${title}`)
  }
  const hidden = commits.length - shown.length
  if (hidden > 0) lines.push(`- and ${hidden} more commit(s)`)
  lines.push(`Changed files since last review: ${diffs.length}`)
  return lines.join('\n')
}

export type IncrementalPlan =
  | { kind: 'interdiff'; files: InterdiffFile[] }
  | { kind: 'full'; reason: 'base changed' | 'prior base unknown' | 'prior head unreachable' | 'interdiff too large' | 'prior review partial' }

/**
 * Whether a re-review can look at the interdiff alone (spec section 6, P6):
 * only when the MR base is the one the prior review recorded (a rebase moves
 * it, and a compare across a rebase mixes in the target's changes), the prior
 * head is still reachable, and GitLab sent every file's text. Pure.
 */
export function planIncremental(
  prior: { headSha: string; baseSha?: string; partial?: boolean },
  current: { headSha: string; baseSha?: string },
  compare: CompareResult | undefined,
): IncrementalPlan {
  if (prior.partial === true) return { kind: 'full', reason: 'prior review partial' }
  if (prior.baseSha === undefined || current.baseSha === undefined) return { kind: 'full', reason: 'prior base unknown' }
  if (prior.baseSha !== current.baseSha) return { kind: 'full', reason: 'base changed' }
  if (compare === undefined) return { kind: 'full', reason: 'prior head unreachable' }
  const files: InterdiffFile[] = []
  for (const d of compare.diffs ?? []) {
    if (d.too_large === true || d.collapsed === true || typeof d.diff !== 'string' || typeof d.new_path !== 'string') return { kind: 'full', reason: 'interdiff too large' }
    files.push(d as InterdiffFile)
  }
  return { kind: 'interdiff', files }
}
