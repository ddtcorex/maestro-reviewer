import type { ReviewFinding } from './review-findings-tool.js'
import { findingFingerprint } from './review-marker.js'
import { normalizeFindingSeverity } from './severity.js'

/**
 * GitLab Code Quality output (spec section 7, F3): the review job's findings
 * as a Code Climate report, plus an opt-in merge gate the reviewer project's
 * operator sets (`REVIEW_GATE`), never the source repository.
 */

export interface CodeQualityIssue {
  description: string
  check_name: string
  fingerprint: string
  severity: 'info' | 'minor' | 'major' | 'critical' | 'blocker'
  location: { path: string; lines: { begin: number } }
}

const SEVERITY = { nit: 'info', minor: 'minor', major: 'major', blocking: 'critical' } as const

/** Pure. New findings with a position only: replies belong to existing threads. */
export function toCodeQuality(findings: ReviewFinding[]): CodeQualityIssue[] {
  return findings.flatMap((f) => {
    if (f.status !== 'new' || f.path === undefined || f.line === undefined) return []
    const check = f.code ?? f.category ?? 'maestro-review'
    const sentence = (f.body.split('\n')[0].match(/^.*?[.!?](?=\s|$)/)?.[0] ?? f.body.split('\n')[0]).slice(0, 200)
    return [{
      description: `${check}: ${sentence}`, check_name: check, fingerprint: findingFingerprint(f),
      severity: SEVERITY[normalizeFindingSeverity(f.severity)], location: { path: f.path, lines: { begin: f.line } },
    }]
  })
}

export type ReviewGate = 'off' | 'blocking'

/** 3 fails the review job on a blocking finding when the gate is on; infra errors keep their own code. */
export function gateExitCode(findings: ReviewFinding[], gate: ReviewGate): 0 | 3 {
  return gate === 'blocking' && findings.some((f) => normalizeFindingSeverity(f.severity) === 'blocking') ? 3 : 0
}
