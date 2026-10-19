import type { CompareResult } from './forge/types.js'
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
): string | undefined {
  if (sinceSha === undefined || nowSha === undefined || sinceSha === nowSha) return undefined
  if (compare === undefined) return undefined
  const commits = compare.commits ?? []
  const diffs = compare.diffs ?? []
  if (commits.length === 0 && diffs.length === 0) return undefined

  const lines: string[] = [
    `This MR was reviewed before (at ${sinceSha.slice(0, 12)}). The following is what changed since then — focus your review on these files and commits, and re-check only open threads whose location falls inside them:`,
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
