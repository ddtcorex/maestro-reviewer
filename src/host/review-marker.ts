/**
 * Machine-readable review comment identity (spec: coexistence §4-5).
 *
 * Every posted review comment (webhook + CI, quick + deep) ends with an
 * invisible marker so the CI flow can detect "this head SHA already has a
 * completed review" without access to the webhook's history store.
 */

import { createHash } from 'node:crypto'
import type { ReviewFinding } from './review-findings-tool.js'

export type ReviewFlow = 'ci-quick' | 'ci-deep' | 'webhook'

export function reviewMarker(sha: string, flow: ReviewFlow): string {
  return `<!-- maestro-review sha=${sha} flow=${flow} status=completed -->`
}

export function parseReviewMarker(body: string): { sha: string; flow: string; status: string } | undefined {
  const m = /<!-- maestro-review sha=([0-9a-fA-F]+) flow=([a-z-]+) status=([a-z]+) -->/.exec(body)
  if (!m) return undefined
  return { sha: m[1], flow: m[2], status: m[3] }
}

/** CI detection is env-based (established pattern): the reviewer job always sets these. */
export function resolveFlow(mode: 'quick' | 'deep'): ReviewFlow {
  if (process.env.SOURCE_PROJECT_ID === undefined) return 'webhook'
  return mode === 'deep' ? 'ci-deep' : 'ci-quick'
}

/**
 * Versioned, hidden review metadata (spec §4.1). Cross-job state (push-gate,
 * incremental base, feedback counts, periodic report) is read back from the
 * newest bot comment through the API instead of the runner cache, which is
 * per runner and races across concurrent jobs. Never carries diff text, file
 * content or secrets: findings are reduced to code, fingerprint and severity.
 */
export interface ReviewMeta {
  v: 1
  headSha: string
  baseSha?: string
  mode: 'quick' | 'deep'
  models: string[]
  usage?: { input: number; output: number; cached: number }
  findings: Array<{ code: string; fingerprint: string; severity: string }>
  muted?: string[]
  truncated?: boolean
  /** The review did not see every file (a failed fan-out part, a capped diff): the next one must be full. */
  partial?: boolean
  at: string
}

export const META_MAX_BYTES = 8192
const META_RE = /<!-- maestro-review-meta:v1 ([A-Za-z0-9_-]+) -->/

const wrap = (m: ReviewMeta) => `<!-- maestro-review-meta:v1 ${Buffer.from(JSON.stringify(m)).toString('base64url')} -->`

export function encodeReviewMeta(meta: ReviewMeta): string {
  let block = wrap(meta)
  if (Buffer.byteLength(block) <= META_MAX_BYTES) return block
  let keep = meta.findings.length
  while (keep > 0) {
    keep = Math.floor(keep * 0.8)
    block = wrap({ ...meta, findings: meta.findings.slice(0, keep), truncated: true })
    if (Buffer.byteLength(block) <= META_MAX_BYTES) return block
  }
  return wrap({ ...meta, findings: [], truncated: true })
}

const isStr = (x: unknown): x is string => typeof x === 'string'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function isReviewMeta(x: unknown): x is ReviewMeta {
  if (x === null || typeof x !== 'object') return false
  const m = x as Record<string, unknown>
  if (m.v !== 1 || !isStr(m.headSha) || !/^[0-9a-fA-F]+$/.test(m.headSha) || !isStr(m.at)) return false
  if (m.mode !== 'quick' && m.mode !== 'deep') return false
  if (m.baseSha !== undefined && !isStr(m.baseSha)) return false
  if (!Array.isArray(m.models) || !m.models.every(isStr)) return false
  if (!Array.isArray(m.findings) || !m.findings.every(f => f !== null && typeof f === 'object'
    && isStr((f as Record<string, unknown>).code) && isStr((f as Record<string, unknown>).fingerprint) && isStr((f as Record<string, unknown>).severity))) return false
  if (m.usage !== undefined) {
    const u = m.usage as Record<string, unknown>
    if (u === null || typeof u !== 'object' || !isNum(u.input) || !isNum(u.output) || !isNum(u.cached)) return false
  }
  if (m.muted !== undefined && (!Array.isArray(m.muted) || !m.muted.every(isStr))) return false
  if (m.truncated !== undefined && typeof m.truncated !== 'boolean') return false
  if (m.partial !== undefined && typeof m.partial !== 'boolean') return false
  return true
}

/** The metadata of one note body; undefined for a missing, edited, foreign or malformed block. */
export function parseReviewMeta(noteBody: string): ReviewMeta | undefined {
  const m = META_RE.exec(noteBody)
  if (!m) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'))
    return isReviewMeta(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Identity of a finding that survives line moves and whitespace edits. */
export function findingFingerprint(f: ReviewFinding): string {
  const body = f.body.replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(`${f.path ?? ''}\n${f.code ?? f.category ?? 'none'}\n${body}`).digest('hex')
}

export function buildReviewMeta(opts: {
  headSha: string
  baseSha?: string
  mode: 'quick' | 'deep'
  models: string[]
  findings: ReviewFinding[]
  usage?: { input: number; output: number; cached: number }
  partial?: boolean
  muted?: string[]
  /** Findings of an earlier review of this head that this (narrower) review must not drop. */
  carried?: ReviewMeta['findings']
  now?: () => Date
}): ReviewMeta {
  return {
    v: 1,
    headSha: opts.headSha,
    ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
    mode: opts.mode,
    models: opts.models,
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    ...(opts.partial === true ? { partial: true } : {}),
    ...(opts.muted !== undefined && opts.muted.length > 0 ? { muted: opts.muted } : {}),
    findings: [
      ...opts.findings.map(f => ({ code: f.code ?? 'none', fingerprint: findingFingerprint(f), severity: f.severity ?? 'minor' })),
      ...(opts.carried ?? []).filter(c => !opts.findings.some(f => findingFingerprint(f) === c.fingerprint)),
    ],
    at: (opts.now ?? (() => new Date()))().toISOString(),
  }
}
