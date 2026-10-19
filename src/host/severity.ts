import type { FindingSeverity, ReviewFinding } from './review-findings-tool.js'

export const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocking', 'major', 'minor', 'nit'] as const

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocking: '🔴 Blocking',
  major: '🟡 Major',
  minor: '🔵 Minor',
  nit: '⚪ Nit',
}

/** Missing or unknown severities degrade to `minor` — never drop a finding. */
export function normalizeFindingSeverity(severity: unknown): FindingSeverity {
  return severity === 'blocking' || severity === 'major' || severity === 'minor' || severity === 'nit'
    ? severity
    : 'minor'
}

export function severityPrefix(severity: unknown): string {
  return SEVERITY_LABEL[normalizeFindingSeverity(severity)]
}

/** Count findings per severity; zero counts are omitted. */
export function countFindingSeverities(findings: ReviewFinding[]): Partial<Record<FindingSeverity, number>> {
  const counts: Partial<Record<FindingSeverity, number>> = {}
  for (const finding of findings) {
    const level = normalizeFindingSeverity(finding.severity)
    counts[level] = (counts[level] ?? 0) + 1
  }
  return counts
}
