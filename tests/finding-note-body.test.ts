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

  it('leaves a body without an echo untouched', () => {
    expect(stripHeaderEcho('Plain body.', 'A-CODE')).toBe('Plain body.')
    expect(stripHeaderEcho('- a list item', undefined)).toBe('- a list item')
  })
})
