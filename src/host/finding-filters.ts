import { normalize as posixNormalize } from 'node:path/posix'
import type { ReviewFinding } from './review-findings-tool.js'
import { normalizeFindingSeverity } from './severity.js'

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
