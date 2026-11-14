import { describe, expect, it } from 'vitest'
import { NOTE_MARKER, hasReviewerMarker, isReviewerNote } from '../src/host/reviewer-note.js'

describe('isReviewerNote', () => {
  it('needs the bot account', () => {
    const body = 'x\n\n<!-- maestro-finding code=A-B -->'
    expect(isReviewerNote({ body }, true)).toBe(true)
    expect(isReviewerNote({ body }, false)).toBe(false)
  })

  it.each([
    '<!-- maestro-review sha=abc123 flow=ci status=completed -->',
    'summary\n<!-- maestro-review-meta:v1 eyJ2IjoxfQ -->',
    'Re-reviewed.\n\n<!-- maestro-command note=1 -->',
    'Failed.\n\n<!-- maestro-command-retry note=1 -->',
    `Still open.\n\n${NOTE_MARKER}`,
  ])('reads a reviewer marker %#', (body) => {
    expect(hasReviewerMarker(body)).toBe(true)
    expect(isReviewerNote({ body }, true)).toBe(true)
  })

  it.each([
    '🔵 Minor · `X-CODE`\n\ntext',
    '🔵 Minor (was 🟡 Major)\n\ntext',
    '**Inline fallback: `a.php:3` is outside the files this MR changes**\n\n🟡 Major\n\ntext',
  ])('reads the legacy severity label %#', (body) => {
    expect(isReviewerNote({ body }, true)).toBe(true)
  })

  it.each([
    'Minor point: the name is long.',
    '/maestro dismiss not a bug',
    'Thanks, fixed in the next commit.',
  ])('reads a person written with the bot account %#', (body) => {
    expect(isReviewerNote({ body }, true)).toBe(false)
  })

  it('never counts a system note', () => {
    expect(isReviewerNote({ body: '🔵 Minor', system: true }, true)).toBe(false)
  })
})
