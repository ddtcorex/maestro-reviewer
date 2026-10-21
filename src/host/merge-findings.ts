import type { ReviewFinding } from './review-findings-tool.js'
import { findingFingerprint } from './review-marker.js'
import { SEVERITY_ORDER, normalizeFindingSeverity } from './severity.js'

/**
 * Findings of several review parts, deduped (a duplicate keeps the highest
 * severity): new findings by fingerprint, replies by discussion, so two parts
 * answering the same thread post once and identical words on two threads
 * both post. Pure.
 */
export function mergeFindings(lists: ReviewFinding[][]): ReviewFinding[] {
  const byPrint = new Map<string, ReviewFinding>()
  for (const finding of lists.flat()) {
    const key = finding.status === 'reply' && finding.discussionId !== undefined ? `reply:${finding.discussionId}` : findingFingerprint(finding)
    const seen = byPrint.get(key)
    if (seen === undefined) { byPrint.set(key, finding); continue }
    const rank = (f: ReviewFinding) => SEVERITY_ORDER.indexOf(normalizeFindingSeverity(f.severity))
    if (rank(finding) < rank(seen)) byPrint.set(key, { ...seen, severity: finding.severity })
  }
  return [...byPrint.values()]
}
