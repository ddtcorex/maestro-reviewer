import { openerSeverity } from './finding-filters.js'

/** Marks a reviewer note that carries no other marker (a reply without a code). */
export const NOTE_MARKER = '<!-- maestro-note -->'

const MARKERS = /<!-- maestro-(?:finding code=|review sha=|review-meta:v1 |command note=|command-retry note=|note -->|head sha=)/

/** The MR head a reviewer note was written at. */
export function headMarker(sha: string): string {
  return `<!-- maestro-head sha=${sha} -->`
}

const HEAD_RE = /<!-- maestro-head sha=([0-9a-f]{7,64}) -->/

export function noteHead(body: string): string | undefined {
  return HEAD_RE.exec(body)?.[1]
}

/** A command answer or retry note: the reviewer talking, not reviewing the code. */
export function isCommandAnswer(body: string): boolean {
  return /<!-- maestro-command(?:-retry)? note=/.test(body)
}

export function hasReviewerMarker(body: string): boolean {
  return MARKERS.test(body)
}

/**
 * Whether the reviewer wrote this note. The bot account is necessary but not
 * enough: on a shared account the person behind the token writes with it too.
 * A reviewer note carries a marker, or, from 0.21 and earlier, starts with a
 * severity label; anything else written with the account is a person's.
 */
export function isReviewerNote(note: { body?: string; system?: boolean }, byBotAccount: boolean): boolean {
  if (!byBotAccount || note.system === true) return false
  const body = note.body ?? ''
  return hasReviewerMarker(body) || openerSeverity(body) !== undefined
}
