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
  /** "external" when the finding rests on framework or vendor code that is not in the checkout. */
  premise?: 'checkout' | 'external'
  /** A reply's verdict on its thread's finding: fixed by the new commits, or still open. */
  resolution?: 'open' | 'fixed'
  /** Checkout places that show the defect; required for major and blocking. */
  evidence?: Array<{ path: string; line: number }>
  /** Engine only: who called the premise external, recorded in the review metadata. */
  premiseBy?: PremiseSource
  /** Engine-only: the MR head this finding was reviewed at, written into its note. */
  reviewedHead?: string
  /** Engine only: the severity of the thread a reply belongs to. */
  threadSeverity?: FindingSeverity
  /** Engine only: a line explaining a severity the engine changed. */
  severityNote?: string
}

export type PremiseSource = 'model' | 'text' | 'both'

export const FINDING_CODE_RE = /^[A-Z][A-Z0-9-]{2,40}$/

const validEvidence = (e: unknown): e is { path: string; line: number } =>
  typeof e === 'object' && e !== null && typeof (e as { path?: unknown }).path === 'string'
  && Number.isInteger((e as { line?: unknown }).line) && (e as { line: number }).line > 0

/** Drops malformed `code`, `premise` and `evidence` values so one bad field never loses the finding itself. */
export function normalizeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.map((f) => {
    const { code, premise, evidence, resolution, ...rest } = f
    const kept: ReviewFinding = { ...rest }
    if (code !== undefined && FINDING_CODE_RE.test(code)) kept.code = code
    if (premise === 'checkout' || premise === 'external') kept.premise = premise
    if (f.status === 'reply' && (resolution === 'open' || resolution === 'fixed')) kept.resolution = resolution
    const entries = Array.isArray(evidence) ? evidence.filter(validEvidence).map((e) => ({ path: e.path, line: e.line })) : []
    if (entries.length > 0) kept.evidence = entries
    return kept
  })
}

export interface Config {
  onReport: (findings: ReviewFinding[]) => void
  /** False where codes are never used, e.g. a discussion review whose findings become replies. */
  requireCodes?: boolean
}

/** Tool parameters; exported so tests can pin the schema the model sees. */
export const FINDINGS_PARAMETERS = {
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
        resolution: { type: 'string', enum: ['open', 'fixed'], description: 'For a reply: "fixed" when the new commits resolve the thread\'s finding, "open" when it still applies. Leave it out for a new finding.' },
        premise: { type: 'string', enum: ['checkout', 'external'], description: '"external" when the finding rests on how a framework, library or vendor package behaves and that code is not in the checkout; otherwise "checkout".' },
        evidence: {
          type: 'array',
          description: 'Places in the checkout that show the defect. Required for major and blocking, which are lowered to minor without it.',
          items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, line: { type: 'number', required: true } } },
        },
      },
    },
  },
}

export function apply(ctx: Context, config: Config): void {
  // A new finding without a code cannot be matched to its thread on the next run,
  // so the report goes back once; the second attempt is kept as is.
  let askedForCodes = false
  ctx.tools.register(defineTool({
    name: 'report_review_findings',
    description: 'Submit your complete list of review findings exactly once, when done analyzing. Each finding is {status: "new", path, line, body, severity, category?} for a location with no existing thread, or {status: "reply", discussionId, body, severity, resolution, category?} to update an existing thread (resolution "fixed" when the new commits fix it, "open" when it still applies) returned by gitlab_list_own_review_threads (reply to a resolved thread reopens it; prefer reply over new when the substance matches). Severity (required in spirit, defaults to minor): blocking = must fix before merge (regression, data loss, real XSS/RCE); major = should fix (correctness bug, security hardening with a realistic path); minor = nice to fix (perf nit with impact, stale docs, fragile coupling); nit = style/micro with no behavior impact.',
    parameters: FINDINGS_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { received: { type: 'number', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Recorded ${value.received} finding(s).` }],
    },
    async execute(args) {
      const findings = normalizeFindings(args.findings as ReviewFinding[])
      const uncoded = findings.flatMap((f, i) => f.status === 'new' && f.code === undefined ? [i + 1] : [])
      // Recorded before asking, so a reviewer that never resends still posts its findings.
      config.onReport(findings)
      if (uncoded.length > 0 && config.requireCodes !== false && !askedForCodes) {
        askedForCodes = true
        throw new Error(`Recorded provisionally: finding ${uncoded.join(', ')} has no code. Give every new finding a code (uppercase with dashes, e.g. BUG-STALE-CACHE) and call report_review_findings again with the complete list; it replaces this one.`)
      }
      return { received: findings.length }
    },
  }))
}
