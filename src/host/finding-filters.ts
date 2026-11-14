import { normalize as posixNormalize } from 'node:path/posix'
import type { CompareResult, MrVersion, ThreadState } from './forge/types.js'
import type { FindingSeverity, PremiseSource, ReviewFinding } from './review-findings-tool.js'
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
  // The vendor source itself must be what is missing: "the migration is not included in
  // the repository" or "the library code path is not readable" are checkout defects.
  /\b(vendor|framework|library|third[- ]party) (source|code|files?) (is |are )?not (available|present|included|readable)\b/i,
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
  return premiseSource(f) === undefined ? 'checkout' : 'external'
}

/** Who called the premise external: the model's declaration, the body's wording, or both; undefined when neither did. */
export function premiseSource(f: ReviewFinding): PremiseSource | undefined {
  const declared = f.premise === 'external'
  const text = saysVendorMissing(f.body)
  return declared && text ? 'both' : declared ? 'model' : text ? 'text' : undefined
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

type ChangeDeps = {
  versions: MrVersion[] | undefined
  compare: (from: string, to: string) => Promise<CompareResult | undefined>
  headSha: string
}

/** No commit between `from` and the current head touched the thread's lines; a failed compare answers false. */
/** The text names this file: its full path, or a file name with an extension as a word. */
function namesPath(text: string, path: string): boolean {
  if (text.includes(path)) return true
  const base = path.split('/').at(-1) ?? ''
  return /\.[A-Za-z0-9]+$/.test(base) && base.length >= 5 && new RegExp(`(^|[^\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text)
}

/**
 * No commit between `from` and the current head touched the thread's lines, or
 * changed a file `mentions` names (a fix attempt made elsewhere that the reply
 * answers); a failed compare answers false.
 */
export async function isUnchangedFrom(from: string, t: ThreadState, deps: Pick<ChangeDeps, 'compare' | 'headSha'>, mentions = ''): Promise<boolean> {
  if (from === deps.headSha) return true
  const result = await deps.compare(from, deps.headSha)
  if (result === undefined || result.compare_timeout === true || result.diffs === undefined) return false
  if (mentions !== '' && result.diffs.some((d) => typeof d.new_path === 'string' && d.new_path !== t.path && namesPath(mentions, d.new_path))) return false
  return !result.diffs.some((d) => (d.new_path === t.path || d.old_path === t.path) && (d.diff === undefined || d.too_large === true || d.collapsed === true || touches(d.diff, t.line)))
}

/**
 * No commit since `at` touched the thread's lines. The head at that time is the
 * newest version created at or before it. Any missing piece (time, versions,
 * compare) answers false, so the reply is posted.
 */
export async function isUnchangedSince(at: string | undefined, t: ThreadState, deps: ChangeDeps, mentions = ''): Promise<boolean> {
  if (at === undefined || deps.versions === undefined) return false
  // Instants, not text: GitLab times may differ in offset form and milliseconds.
  const since = Date.parse(at)
  if (Number.isNaN(since)) return false
  const before = deps.versions
    .map((v) => ({ v, at: Date.parse(v.createdAt) }))
    .filter((x) => !Number.isNaN(x.at) && x.at <= since)
    .sort((a, b) => a.at - b.at)
    .at(-1)?.v
  if (before === undefined) return false
  return isUnchangedFrom(before.headSha, t, deps, mentions)
}

/** The thread was answered by a person and no commit since touched its lines. */
export async function isAnsweredUnchanged(t: ThreadState, deps: ChangeDeps): Promise<boolean> {
  return t.lastIsHuman && isUnchangedSince(t.lastHumanAt, t, deps)
}

/**
 * A reply takes its thread's current severity (the latest the reviewer stated,
 * else the opener's) when it reports none, and records it for rendering, so a
 * move back to the opener's severity is shown as a change too.
 */
export function effectiveReply(f: ReviewFinding, t: ThreadState | undefined): ReviewFinding {
  const current = t?.currentSeverity ?? t?.severity
  if (f.status !== 'reply' || current === undefined) return f
  return { ...f, severity: f.severity ?? current, threadSeverity: current }
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
  /** Findings to post whose premise is external; marked with `premise` and `premiseBy`, and posted like any other. */
  external: number
  lowered: number
  answered: number
  /** Same-severity replies in unanswered threads whose code did not change since the reviewer's last note. */
  restated: number
  /**
   * Each filtered input (by identity) to the finding the run records: the
   * effective one when posted or dropped (lowered, or a reply with its
   * thread's severity), marked with its premise when external.
   */
  effective: Map<ReviewFinding, ReviewFinding>
  /** A major or blocking finding could not be checked because files cannot be read or a read failed. */
  evidenceSkipped: boolean
}

/**
 * Evidence first, for new findings (a lowered finding is then judged like any other), then the
 * external premise (recorded, never a reason to hold a finding back: in replay it did not
 * separate wrong findings from right ones), then replies to answered threads, then the
 * reply's severity against its thread.
 */
export async function applyFilters(findings: ReviewFinding[], ctx: FilterContext): Promise<FilterResult> {
  const out: FilterResult = { post: [], external: 0, lowered: 0, answered: 0, restated: 0, effective: new Map(), evidenceSkipped: false }
  // Replies answered on the same version share one compare.
  const compares = new Map<string, Promise<CompareResult | undefined>>()
  const compare = (from: string, to: string) => {
    const key = `${from}..${to}`
    let result = compares.get(key)
    if (result === undefined) compares.set(key, result = ctx.compare(from, to))
    return result
  }
  for (const reported of findings) {
    // Evidence is asked of new findings only: a reply restates its thread, whose
    // opener the gate reads, and lowering it would render as a downgrade.
    const judged = reported.status === 'new' ? await judgeEvidence(reported, ctx.lines) : { finding: reported, skipped: false }
    if (judged.skipped) out.evidenceSkipped = true
    if (judged.finding !== reported) out.lowered++
    const premiseBy = premiseSource(judged.finding)
    const f = premiseBy === undefined ? judged.finding : { ...judged.finding, premise: 'external' as const, premiseBy }
    const thread = f.status === 'reply' ? ctx.threads?.find((t) => t.discussionId === f.discussionId) : undefined
    const effective = effectiveReply(f, thread)
    out.effective.set(reported, effective)
    const deps = { versions: ctx.versions, compare, headSha: ctx.headSha }
    if (thread !== undefined && await isAnsweredUnchanged(thread, deps)) {
      out.answered++
      continue
    }
    // A reply that only restates an open finding on untouched code adds nothing; a severity change does.
    // A thread resolved since the reviewer last wrote in it gets its reply once: an unfixed finding closed without a word.
    const resolvedSince = thread?.resolvedAt !== undefined && (thread.lastBotAt === undefined || Date.parse(thread.resolvedAt) > Date.parse(thread.lastBotAt))
    // A reply that reports a fix is news, whatever changed under the thread.
    if (thread !== undefined && !thread.lastIsHuman && !resolvedSince && effective.resolution !== 'fixed' && effective.threadSeverity !== undefined && effective.severity === effective.threadSeverity
      // The head the reviewer read is exact; a note time only approximates it (older notes record no head).
      && await (thread.lastBotHead !== undefined ? isUnchangedFrom(thread.lastBotHead, thread, deps, effective.body) : isUnchangedSince(thread.lastBotAt, thread, deps, effective.body))) {
      out.restated++
      continue
    }
    if (premiseBy !== undefined) out.external++
    out.post.push({ ...effective, reviewedHead: ctx.headSha })
  }
  return out
}

/** One sentence on what the filters did; empty when they did nothing. */
export function filterNotice(r: Pick<FilterResult, 'lowered' | 'answered' | 'evidenceSkipped'> & { restated?: number }): string {
  const restated = r.restated ?? 0
  const parts = [
    ...(r.lowered > 0 ? [`${r.lowered} lowered to minor`] : []),
    ...(r.answered > 0 ? [`${r.answered} ${r.answered === 1 ? 'reply' : 'replies'} to answered threads not posted`] : []),
    ...(restated > 0 ? [`${restated} restated ${restated === 1 ? 'reply' : 'replies'} on unchanged code not posted`] : []),
  ]
  const counts = parts.length > 0 ? `${parts.join(', ')}.` : ''
  return [counts, ...(r.evidenceSkipped ? ['Evidence check skipped: files could not be read.'] : [])].filter((s) => s !== '').join(' ')
}
