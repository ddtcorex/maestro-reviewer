import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'maestro-review-findings-tool'
export const inject = ['tools']

export type FindingSeverity = 'blocking' | 'major' | 'minor' | 'nit'

export interface ReviewFinding {
  status: 'new' | 'reply'
  body: string
  path?: string
  line?: number
  discussionId?: string
  /** Assigned by the reviewer; missing values are treated as `minor`. */
  severity?: FindingSeverity
  /** Optional area tag, e.g. security, correctness, perf, style. */
  category?: string
  /** Optional short stable id such as SEC-XSS-ESCAPE; malformed values are dropped, not rejected. */
  code?: string
}

export const FINDING_CODE_RE = /^[A-Z][A-Z0-9-]{2,40}$/

/** Drops a malformed `code` so one bad field never loses the finding itself. */
export function normalizeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.map((f) => {
    if (f.code === undefined || FINDING_CODE_RE.test(f.code)) return f
    const { code: _dropped, ...rest } = f
    return rest
  })
}

export interface Config {
  onReport: (findings: ReviewFinding[]) => void
}

export function apply(ctx: Context, config: Config): void {
  // A new finding without a code cannot be matched to its thread on the next run.
  // The report goes back once; a second attempt is kept as is so no review is lost.
  let askedForCodes = false
  ctx.tools.register(defineTool({
    name: 'report_review_findings',
    description: 'Submit your complete list of review findings exactly once, when done analyzing. Each finding is {status: "new", path, line, body, severity, category?} for a location with no existing thread, or {status: "reply", discussionId, body, severity, category?} to update an existing thread returned by gitlab_list_own_review_threads (reply to a resolved thread reopens it — prefer reply over new when the substance matches). Severity (required in spirit, defaults to minor): blocking = must fix before merge (regression, data loss, real XSS/RCE); major = should fix (correctness bug, security hardening with a realistic path); minor = nice to fix (perf nit with impact, stale docs, fragile coupling); nit = style/micro with no behavior impact.',
    parameters: {
      findings: {
        type: 'array',
        required: true,
        description: 'The complete list of findings for this review.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['new', 'reply'], required: true },
            body: { type: 'string', required: true },
            path: { type: 'string' },
            line: { type: 'number' },
            discussionId: { type: 'string' },
            severity: { type: 'string', enum: ['blocking', 'major', 'minor', 'nit'] },
            category: { type: 'string' },
            code: { type: 'string', description: 'Required for a new finding: short stable id for the kind of issue, uppercase with dashes, e.g. SEC-XSS-ESCAPE or PERF-N-PLUS-ONE. Reuse the same code for the same kind of issue.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { received: { type: 'number', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Recorded ${value.received} finding(s).` }],
    },
    async execute(args) {
      const findings = normalizeFindings(args.findings as ReviewFinding[])
      const uncoded = findings.flatMap((f, i) => f.status === 'new' && f.code === undefined ? [i + 1] : [])
      if (uncoded.length > 0 && !askedForCodes) {
        askedForCodes = true
        throw new Error(`Nothing was recorded: finding ${uncoded.join(', ')} has no code. Give every new finding a code (uppercase with dashes, e.g. BUG-STALE-CACHE) and call report_review_findings again with the complete list.`)
      }
      config.onReport(findings)
      return { received: findings.length }
    },
  }))
}
