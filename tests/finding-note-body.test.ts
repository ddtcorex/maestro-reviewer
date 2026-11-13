import { describe, expect, it } from 'vitest'
import { findingNoteBody, stripHeaderEcho } from '../src/host/forge/gitlab/mr-api.js'

const visible = (b: string) => b.replace(/<!--[\s\S]*?-->/g, '')

describe('findingNoteBody header echo', () => {
  it('drops an echoed code after the header', () => {
    const b = findingNoteBody({ status: 'reply', discussionId: 'd', body: '· `LAYOUT-X` \u2014 still open, see below.', severity: 'minor', code: 'LAYOUT-X' })
    expect(visible(b).match(/`LAYOUT-X`/g)).toHaveLength(1)
    expect(b).toContain('still open, see below.')
  })

  it('drops a different echoed severity label', () => {
    const b = findingNoteBody({ status: 'new', path: 'a', line: 1, body: '🔵 Minor · `ROBUST-X` Null guard missing.', severity: 'nit', code: 'ROBUST-X' })
    expect(b.startsWith('⚪ Nit · `ROBUST-X`')).toBe(true)
    expect(b).not.toContain('🔵 Minor')
    expect(visible(b).match(/`ROBUST-X`/g)).toHaveLength(1)
    expect(b).toContain('Null guard missing.')
  })

  it('drops a repeated echo', () => {
    const b = findingNoteBody({ status: 'new', path: 'a', line: 1, body: '`X-CODE` · `X-CODE` text', severity: 'minor', code: 'X-CODE' })
    expect(visible(b).match(/`X-CODE`/g)).toHaveLength(1)
    expect(b).toMatch(/\n\ntext/)
  })

  it('keeps a body that is only an echo', () => {
    const b = findingNoteBody({ status: 'new', path: 'a', line: 1, body: '· `ONLY-X`', severity: 'minor', code: 'ONLY-X' })
    expect(b).toMatch(/· `ONLY-X`\n\n· `ONLY-X`/)
  })

  it('never strips another code at the start', () => {
    const b = findingNoteBody({ status: 'new', path: 'a', line: 1, body: '`OTHER-Y` is wrong', severity: 'minor', code: 'X-CODE' })
    expect(b).toContain('\n\n`OTHER-Y` is wrong')
  })

  it('keeps an exact label echo stripped as before', () => {
    const b = findingNoteBody({ status: 'new', path: 'a', line: 1, body: '🔵 Minor Escape the output.', severity: 'minor' })
    expect(b).toBe('🔵 Minor\n\nEscape the output.')
  })
})

describe('stripHeaderEcho', () => {
  it('removes a separator after the echo', () => {
    expect(stripHeaderEcho('`A-CODE` - rest', 'A-CODE')).toBe('rest')
    expect(stripHeaderEcho('`A-CODE` · rest', 'A-CODE')).toBe('rest')
  })

  it('takes a separator only on the echo line and before a space', () => {
    expect(stripHeaderEcho('`A-CODE`\n\n- first bullet\n- second', 'A-CODE')).toBe('- first bullet\n- second')
    expect(stripHeaderEcho('`A-CODE` -1 is returned', 'A-CODE')).toBe('-1 is returned')
    expect(stripHeaderEcho('`A-CODE` \u2014 rest', 'A-CODE')).toBe('rest')
  })

  it('leaves a body without an echo untouched', () => {
    expect(stripHeaderEcho('Plain body.', 'A-CODE')).toBe('Plain body.')
    expect(stripHeaderEcho('- a list item', undefined)).toBe('- a list item')
  })
})

describe('reply severity header', () => {
  it('shows the code alone when the reply matches its thread', () => {
    const b = findingNoteBody({ status: 'reply', discussionId: 'd', body: 'Still open.', severity: 'major', threadSeverity: 'major', code: 'X-CODE' })
    expect(b.startsWith('`X-CODE`\n\nStill open.')).toBe(true)
  })

  it('shows nothing above the text for a matching reply without a code', () => {
    expect(findingNoteBody({ status: 'reply', discussionId: 'd', body: 'Still open.', severity: 'major', threadSeverity: 'major' })).toBe('Still open.')
  })

  it('shows the change when the reply differs', () => {
    const b = findingNoteBody({ status: 'reply', discussionId: 'd', body: 'Mostly fixed.', severity: 'minor', threadSeverity: 'major', code: 'X-CODE' })
    expect(b.startsWith('🔵 Minor (was 🟡 Major) · `X-CODE`\n\nMostly fixed.')).toBe(true)
  })

  it('keeps the header when the thread severity is unknown', () => {
    const b = findingNoteBody({ status: 'reply', discussionId: 'd', body: 'x', severity: 'minor', code: 'X-CODE' })
    expect(b.startsWith('🔵 Minor · `X-CODE`')).toBe(true)
  })

  it('puts the severity note first in the text', () => {
    const b = findingNoteBody({ status: 'new', path: 'a', line: 1, body: 'The loop skips.', severity: 'minor', severityNote: 'Severity lowered from major: no evidence in the checkout.', code: 'BUG-X' })
    expect(b).toContain('🔵 Minor · `BUG-X`\n\nSeverity lowered from major: no evidence in the checkout.\n\nThe loop skips.')
  })
})

describe('header echo variants seen in replay', () => {
  it('strips a label written without its emoji', () => {
    expect(stripHeaderEcho('Minor · `PAGER-X`\n\nThe pager hides amounts.', 'PAGER-X')).toBe('The pager hides amounts.')
  })

  it('strips a question mark and bold around the echo', () => {
    expect(stripHeaderEcho('❓ **Minor · `PHP-X`** \u2014 question, restated: does it compile?', 'PHP-X')).toBe('question, restated: does it compile?')
    expect(stripHeaderEcho('❓ Minor · `INV-X`\n\nIs the status migrated?', 'INV-X')).toBe('Is the status migrated?')
  })

  it('leaves prose that starts with a severity word or bold text alone', () => {
    expect(stripHeaderEcho('Minor typo in the label.', 'X-CODE')).toBe('Minor typo in the label.')
    expect(stripHeaderEcho('**Bold claim** here.', 'X-CODE')).toBe('**Bold claim** here.')
    expect(stripHeaderEcho('❓ Why is this here?', 'X-CODE')).toBe('❓ Why is this here?')
  })

  it('strips a header led by another emoji', () => {
    expect(stripHeaderEcho('🔩 Nit · `UNUSED-IMPORT`\n\nThe import is unused.', 'UNUSED-IMPORT')).toBe('The import is unused.')
    expect(stripHeaderEcho('🟡 Nit · `CSS-X` text', 'CSS-X')).toBe('text')
  })

  it('leaves prose led by bold or a question mark and a severity word without a separator', () => {
    expect(stripHeaderEcho('**Nit: an entry is classified by a null comparison.**', 'X-CODE')).toBe('**Nit: an entry is classified by a null comparison.**')
    expect(stripHeaderEcho('❓ Minor \u2014 **question, not a claim**', 'X-CODE')).toBe('❓ Minor \u2014 **question, not a claim**')
  })

  it('strips a bold severity word before the code with its closing bold', () => {
    expect(stripHeaderEcho('**Major** · `X-CODE` text', 'X-CODE')).toBe('text')
    expect(stripHeaderEcho('🟡 **Major** · `X-CODE`\n\nThe loop is wrong.', 'X-CODE')).toBe('The loop is wrong.')
  })

  it('keeps bold text that follows an echo', () => {
    expect(stripHeaderEcho('`X-CODE` **important** text', 'X-CODE')).toBe('**important** text')
  })
})
