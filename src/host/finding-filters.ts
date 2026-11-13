import { normalize as posixNormalize } from 'node:path/posix'
import type { CompareResult, MrVersion, ThreadState } from './forge/types.js'
import type { FindingSeverity, ReviewFinding } from './review-findings-tool.js'
import { SEVERITY_ORDER, normalizeFindingSeverity, severityPrefix } from './severity.js'

/**
 * Decisions the engine makes about each reported finding before it is posted.
 * The prompt asks the reviewer for the same behaviour; this module enforces it.
 */

// The reviewer's own phrasing when it reasons about code it cannot read,
// calibrated on posted findings that developers refuted.
const VENDOR_MISSING: readonly RegExp[] = [
  /not (in|part of) (this|the) checkout/i,
  /\b(vendor|framework|library|third[- ]party|core)\b[^.\n]{0,80}\bnot (in|available|present)\b/i,
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

/** Line count of a checkout file at the reviewed head; undefined when the file does not exist. */
export type ReadLineCount = (path: string) => Promise<number | undefined>

/** A relative path that stays inside the checkout once normalized. */
function insideCheckout(path: string): boolean {
  if (path === '' || path.startsWith('/')) return false
  const n = posixNormalize(path)
  return n !== '..' && !n.startsWith('../')
}

/**
 * A major or blocking finding keeps its severity only when one evidence entry
 * names an existing checkout file and a line within it; otherwise it is
 * lowered to minor with a note. Without a reader the check is skipped.
 */
export async function checkEvidence(f: ReviewFinding, lines: ReadLineCount | undefined): Promise<ReviewFinding> {
  const severity = normalizeFindingSeverity(f.severity)
  if ((severity !== 'major' && severity !== 'blocking') || lines === undefined) return f
  for (const e of f.evidence ?? []) {
    if (!insideCheckout(e.path)) continue
    const count = await lines(posixNormalize(e.path))
    if (count !== undefined && e.line >= 1 && e.line <= count) return f
  }
  return { ...f, severity: 'minor', severityNote: `Severity lowered from ${severity}: no evidence in the checkout.` }
}

const FALLBACK_LINE = /^\*\*Inline fallback[^\n]*\*\*\n+/

/** The severity of a thread opener, read from its label (after an inline fallback line, if any). */
export function openerSeverity(firstNoteBody: string): FindingSeverity | undefined {
  const body = firstNoteBody.replace(FALLBACK_LINE, '')
  return SEVERITY_ORDER.find((s) => body.startsWith(severityPrefix(s)))
}

// A change this close to the thread's line counts as touching it.
const TOUCH_WINDOW = 5
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm

function touches(diff: string, line: number | null): boolean {
  if (line === null) return true
  for (const m of diff.matchAll(HUNK_RE)) {
    const start = Number(m[1])
    const end = start + Math.max(Number(m[2] ?? '1'), 1) - 1
    if (start <= line + TOUCH_WINDOW && end >= line - TOUCH_WINDOW) return true
  }
  return false
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
