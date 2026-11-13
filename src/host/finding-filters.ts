import { normalize as posixNormalize } from 'node:path/posix'
import type { CompareResult, MrVersion, ThreadState } from './forge/types.js'
import type { FindingSeverity, ReviewFinding } from './review-findings-tool.js'
import { sanitizeAgentText } from './agent-text.js'
import { SEVERITY_ORDER, normalizeFindingSeverity, severityPrefix } from './severity.js'

/**
 * Decisions the engine makes about each reported finding before it is posted.
 * The prompt asks the reviewer for the same behaviour; this module enforces it.
 */

// The reviewer's own phrasing when it reasons about code it cannot read,
// calibrated on posted findings that developers refuted.
const VENDOR_MISSING: readonly RegExp[] = [
  /not (in|part of) (this|the) checkout/i,
  // Absence must be of source or code, or from the checkout: "the framework escaper
  // is not in use" or "the core check is not present" describe checkout defects.
  /\b(vendor|framework|library|third[- ]party) (source|code|files?)\b[^.\n]{0,60}\bnot (available|present|included|readable)\b/i,
  /\bnot (available|present|included) in (this|the) (checkout|repository|repo|worktree)\b/i,
  /without the (vendor|framework|library) source/i,
  /(can(no|')t|could not|unable to) (see|read|verify|confirm|inspect)[^.\n]{0,60}\b(vendor|checkout)\b/i,
  /\bvendor\/?`?\s+is (an )?empty/i,
  /\bno `?vendor\/?`? (directory |folder )?in (this|the) checkout/i,
]

const prose = (body: string) => body.replace(/```[\s\S]*?```/g, '')

/** The body says the framework or vendor source it relies on was not available. */
export function saysVendorMissing(body: string): boolean {
  const text = prose(body)
  return VENDOR_MISSING.some((r) => r.test(text))
}

/** `external` when declared, or when the body admits the vendor source was missing whatever was declared. */
export function classifyPremise(f: ReviewFinding): 'checkout' | 'external' {
  return f.premise === 'external' || saysVendorMissing(f.body) ? 'external' : 'checkout'
}

/**
 * Line count of a checkout file at the reviewed head: undefined when the file
 * does not exist, null when it could not be read (network, rate limit, server
 * error), which says nothing about whether it exists.
 */
export type ReadLineCount = (path: string) => Promise<number | undefined | null>

/** A relative path that stays inside the checkout once normalized. */
function insideCheckout(path: string): boolean {
  if (path === '' || path.startsWith('/')) return false
  const n = posixNormalize(path)
  return n !== '..' && !n.startsWith('../')
}

/**
 * A major or blocking finding keeps its severity only when one evidence entry
 * names an existing checkout file and a line within it; otherwise it is
 * lowered to minor with a note. Without a reader, or when an entry could not
 * be read, the check is skipped and the severity kept.
 */
export async function judgeEvidence(f: ReviewFinding, lines: ReadLineCount | undefined): Promise<{ finding: ReviewFinding; skipped: boolean }> {
  const severity = normalizeFindingSeverity(f.severity)
  if (severity !== 'major' && severity !== 'blocking') return { finding: f, skipped: false }
  if (lines === undefined) return { finding: f, skipped: true }
  let unreadable = false
  for (const e of f.evidence ?? []) {
    if (!insideCheckout(e.path)) continue
    const count = await lines(posixNormalize(e.path))
    if (count === null) unreadable = true
    else if (count !== undefined && e.line >= 1 && e.line <= count) return { finding: f, skipped: false }
  }
  if (unreadable) return { finding: f, skipped: true }
  return { finding: { ...f, severity: 'minor', severityNote: `Severity lowered from ${severity}: no evidence in the checkout.` }, skipped: false }
}

/** The finding after the evidence check (see judgeEvidence). */
export async function checkEvidence(f: ReviewFinding, lines: ReadLineCount | undefined): Promise<ReviewFinding> {
  return (await judgeEvidence(f, lines)).finding
}

const FALLBACK_LINE = /^\*\*Inline fallback[^\n]*\*\*\n+/

/** The severity of a thread opener, read from its label (after an inline fallback line, if any). */
export function openerSeverity(firstNoteBody: string): FindingSeverity | undefined {
  const body = firstNoteBody.replace(FALLBACK_LINE, '')
  return SEVERITY_ORDER.find((s) => body.startsWith(severityPrefix(s)))
}

// A change this close to the thread's line counts as touching it.
const TOUCH_WINDOW = 5
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm

const overlaps = (start: string, count: string | undefined, line: number) => {
  const from = Number(start)
  const to = from + Math.max(Number(count ?? '1'), 1) - 1
  return from <= line + TOUCH_WINDOW && to >= line - TOUCH_WINDOW
}

/**
 * The thread line is in the coordinates of the head at the answer, the old
 * side of the compare; the new side is checked too, and a diff with no
 * readable hunk counts as touching (fail open: the reply is posted).
 */
function touches(diff: string, line: number | null): boolean {
  if (line === null) return true
  const hunks = [...diff.matchAll(HUNK_RE)]
  if (hunks.length === 0) return true
  return hunks.some((m) => overlaps(m[1], m[2], line) || overlaps(m[3], m[4], line))
}

/**
 * The thread was answered by a person and no commit since touched its lines.
 * The head at the answer is the newest version created before it. Any missing
 * piece (versions, compare) answers false, so the reply is posted.
 */
export async function isAnsweredUnchanged(t: ThreadState, deps: {
  versions: MrVersion[] | undefined
  compare: (from: string, to: string) => Promise<CompareResult | undefined>
  headSha: string
}): Promise<boolean> {
  if (!t.lastIsHuman || t.lastHumanAt === undefined || deps.versions === undefined) return false
  const answeredAt = t.lastHumanAt
  const before = deps.versions.filter((v) => v.createdAt <= answeredAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  if (before === undefined) return false
  if (before.headSha === deps.headSha) return true
  const result = await deps.compare(before.headSha, deps.headSha)
  if (result === undefined || result.compare_timeout === true || result.diffs === undefined) return false
  return !result.diffs.some((d) => (d.new_path === t.path || d.old_path === t.path) && (d.diff === undefined || d.too_large === true || d.collapsed === true || touches(d.diff, t.line)))
}

/** A reply takes its thread's severity when it reports none, and records the thread's for rendering. */
export function effectiveReply(f: ReviewFinding, t: ThreadState | undefined): ReviewFinding {
  if (f.status !== 'reply' || t?.severity === undefined) return f
  return { ...f, severity: f.severity ?? t.severity, threadSeverity: t.severity }
}

/** What the engine knows about the run when it filters findings. */
export interface FilterContext {
  mode: 'quick' | 'deep'
  /** Line counts of checkout files; undefined skips the evidence check. */
  lines?: ReadLineCount
  threads?: ThreadState[]
  versions?: MrVersion[]
  compare: (from: string, to: string) => Promise<CompareResult | undefined>
  headSha: string
}

export interface FilterResult {
  /** Findings to post, with their effective severity. */
  post: ReviewFinding[]
  /** External findings kept out of threads in quick mode, marked `premise: 'external'`. */
  moved: ReviewFinding[]
  lowered: number
  answered: number
  /** A major or blocking finding could not be checked because files cannot be read or a read failed. */
  evidenceSkipped: boolean
}

/**
 * Evidence first, for new findings (a lowered finding is then judged like any other), then the
 * external premise (quick mode only), then replies to answered threads, then
 * the reply's severity against its thread.
 */
export async function applyFilters(findings: ReviewFinding[], ctx: FilterContext): Promise<FilterResult> {
  const out: FilterResult = { post: [], moved: [], lowered: 0, answered: 0, evidenceSkipped: false }
  for (const reported of findings) {
    // Evidence is asked of new findings only: a reply restates its thread, whose
    // opener the gate reads, and lowering it would render as a downgrade.
    const judged = reported.status === 'new' ? await judgeEvidence(reported, ctx.lines) : { finding: reported, skipped: false }
    if (judged.skipped) out.evidenceSkipped = true
    const f = judged.finding
    if (f !== reported) out.lowered++
    if (ctx.mode === 'quick' && classifyPremise(f) === 'external') {
      out.moved.push({ ...f, premise: 'external' })
      continue
    }
    const thread = f.status === 'reply' ? ctx.threads?.find((t) => t.discussionId === f.discussionId) : undefined
    if (thread !== undefined && await isAnsweredUnchanged(thread, { versions: ctx.versions, compare: ctx.compare, headSha: ctx.headSha })) {
      out.answered++
      continue
    }
    out.post.push(effectiveReply(f, thread))
  }
  return out
}

const FIRST_SENTENCE_CAP = 200

function firstSentence(body: string): string {
  const text = prose(body).replace(/\s+/g, ' ').trim()
  const end = text.search(/[.!?](\s|$)/)
  const sentence = end < 0 ? text : text.slice(0, end + 1)
  return sentence.length > FIRST_SENTENCE_CAP ? `${sentence.slice(0, FIRST_SENTENCE_CAP - 3)}...` : sentence
}

/** The collapsed summary section listing moved findings; empty when there are none. */
export function assumptionsSection(moved: ReviewFinding[]): string {
  if (moved.length === 0) return ''
  const lines = moved.map((f) => {
    const where = f.status === 'reply' ? 'reply in an existing thread' : `\`${f.path}:${f.line}\``
    // Model text, so escaped like a posted note: it must not plant a marker or metadata block.
    return sanitizeAgentText(`- ${where}${f.code !== undefined ? ` ${f.code}` : ''}: ${firstSentence(f.body)}`)
  })
  return `<details>\n<summary>Unverified assumptions (vendor or framework code not in the checkout): ${moved.length}</summary>\n\n${lines.join('\n')}\n\n</details>`
}

/** One sentence on what the filters did; empty when they did nothing. */
export function filterNotice(r: Pick<FilterResult, 'moved' | 'lowered' | 'answered' | 'evidenceSkipped'>): string {
  const parts = [
    ...(r.moved.length > 0 ? [`${r.moved.length} moved to unverified assumptions`] : []),
    ...(r.lowered > 0 ? [`${r.lowered} lowered to minor`] : []),
    ...(r.answered > 0 ? [`${r.answered} ${r.answered === 1 ? 'reply' : 'replies'} to answered threads not posted`] : []),
  ]
  const counts = parts.length > 0 ? `${parts.join(', ')}.` : ''
  return [counts, ...(r.evidenceSkipped ? ['Evidence check skipped: files could not be read.'] : [])].filter((s) => s !== '').join(' ')
}
