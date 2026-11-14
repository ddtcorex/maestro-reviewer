import { describe, expect, it, vi } from 'vitest'
import { postFindingsSequentially } from '../src/host/engine.js'
import { filterNotice, type FilterContext } from '../src/host/finding-filters.js'
import { mergeFindings } from '../src/host/merge-findings.js'
import type { ReviewFinding } from '../src/host/review-findings-tool.js'
import type { ThreadState } from '../src/host/forge/types.js'

const forge = () => {
  const posted: ReviewFinding[] = []
  return { posted, postFindings: vi.fn(async (fs: ReviewFinding[]) => { posted.push(...fs) }) }
}
const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({ mode: 'quick', lines: async () => 50, compare: vi.fn(async () => undefined), headSha: 'h3', ...over })
const external: ReviewFinding = { status: 'new', path: 'a.php', line: 4, body: 'The vendor source is not in this checkout. Is the quote saved?', severity: 'minor', code: 'GC-SAVE' }
const plain: ReviewFinding = { status: 'new', path: 'a.php', line: 9, body: 'The loop skips the last item.', severity: 'minor', code: 'BUG-LOOP' }

describe('postFindingsSequentially with filters', () => {
  it('lowers an unevidenced blocking finding that passed the floor on its reported severity', async () => {
    const f = forge()
    const blocking: ReviewFinding = { ...plain, severity: 'blocking' }
    const r = await postFindingsSequentially(f, [blocking], { minSeverity: 'major', filters: ctx() })
    expect(f.posted).toHaveLength(1)
    expect(f.posted[0]).toMatchObject({ severity: 'minor', severityNote: 'Severity lowered from blocking: no evidence in the checkout.' })
    expect(r.lowered).toBe(1)
    expect(r.belowMinimum).toBe(0)
  })

  it('keeps a lowered blocking finding exempt from muting', async () => {
    const f = forge()
    await postFindingsSequentially(f, [{ ...plain, severity: 'blocking' }], { muted: new Set(['BUG-LOOP']), filters: ctx() })
    expect(f.posted).toHaveLength(1)
  })

  it('posts external findings in quick mode, marked with who called the premise external', async () => {
    const f = forge()
    const reply: ReviewFinding = { status: 'reply', discussionId: 'd9', body: 'Still unverified: vendor not in this checkout.', severity: 'minor', premise: 'external' }
    const r = await postFindingsSequentially(f, [external, plain, reply], { filters: ctx() })
    expect(f.posted).toHaveLength(3)
    expect(f.posted.map((p) => p.premiseBy)).toEqual(['text', undefined, 'both'])
    expect(f.posted[0].premise).toBe('external')
    expect(r.external).toBe(2)
  })

  it('posts external findings in deep mode', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [external], { filters: ctx({ mode: 'deep' }) })
    expect(f.posted).toHaveLength(1)
    expect(r.external).toBe(1)
  })

  it('drops a reply to an answered thread whose code did not change', async () => {
    const f = forge()
    const thread: ThreadState = { discussionId: 'd1', path: 'a.php', line: 20, severity: 'major', lastHumanAt: '2026-11-02T12:00:00Z', lastIsHuman: true }
    const r = await postFindingsSequentially(f, [{ status: 'reply', discussionId: 'd1', body: 'Still open.' }], {
      filters: ctx({ threads: [thread], versions: [{ headSha: 'h3', createdAt: '2026-11-01T00:00:00Z' }] }),
    })
    expect(f.posted).toHaveLength(0)
    expect(r.answered).toBe(1)
  })

  it('compares once per version pair across answered replies', async () => {
    const at = '2026-11-02T12:00:00Z'
    const threads: ThreadState[] = ['d6', 'd7'].map((id) => ({ discussionId: id, path: 'a.php', line: 20, severity: 'major', lastHumanAt: at, lastIsHuman: true }))
    const compare = vi.fn(async () => ({ diffs: [{ new_path: 'b.php', old_path: 'b.php', diff: '@@ -1,1 +1,1 @@\n-x\n+y\n' }] }))
    const r = await postFindingsSequentially(forge(), ['d6', 'd7'].map((id) => ({ status: 'reply' as const, discussionId: id, body: 'Still open.' })), {
      filters: ctx({ threads, versions: [{ headSha: 'h2', createdAt: '2026-11-01T00:00:00Z' }], compare }),
    })
    expect(r.answered).toBe(2)
    expect(compare).toHaveBeenCalledTimes(1)
  })

  it('gives a reply the thread severity and records it for rendering', async () => {
    const f = forge()
    const thread: ThreadState = { discussionId: 'd2', path: 'a.php', line: 20, severity: 'major', lastIsHuman: false }
    await postFindingsSequentially(f, [{ status: 'reply', discussionId: 'd2', body: 'Still open.' }], { filters: ctx({ threads: [thread] }) })
    expect(f.posted[0]).toMatchObject({ severity: 'major', threadSeverity: 'major' })
  })

  it('never lowers a reply, so it does not render as a downgrade of its thread', async () => {
    const f = forge()
    const thread: ThreadState = { discussionId: 'd3', path: 'a.php', line: 20, severity: 'major', lastIsHuman: false }
    const r = await postFindingsSequentially(f, [{ status: 'reply', discussionId: 'd3', body: 'Still open.', severity: 'major' }], { filters: ctx({ threads: [thread], lines: async () => undefined }) })
    expect(f.posted[0]).toMatchObject({ severity: 'major', threadSeverity: 'major' })
    expect(f.posted[0].severityNote).toBeUndefined()
    expect(r.lowered).toBe(0)
    const { findingNoteBody } = await import('../src/host/forge/gitlab/mr-api.js')
    expect(findingNoteBody({ ...f.posted[0], code: 'BUG-X' }).startsWith('`BUG-X`\n\nStill open.')).toBe(true)
  })

  it('does not report a skipped evidence check for a reply', async () => {
    const r = await postFindingsSequentially(forge(), [{ status: 'reply', discussionId: 'd4', body: 'Still open.', severity: 'blocking' }], { filters: ctx({ lines: undefined }) })
    expect(r.evidenceSkipped).toBe(false)
  })

  it('keeps the severity and reports a skipped check when a file read fails', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [{ ...plain, severity: 'blocking', evidence: [{ path: 'a.php', line: 1 }] }], { filters: ctx({ lines: async () => null }) })
    expect(f.posted[0]).toMatchObject({ severity: 'blocking' })
    expect(r.lowered).toBe(0)
    expect(r.evidenceSkipped).toBe(true)
  })

  it('reports a skipped evidence check when files cannot be read', async () => {
    const r = await postFindingsSequentially(forge(), [{ ...plain, severity: 'major' }], { filters: ctx({ lines: undefined }) })
    expect(r.evidenceSkipped).toBe(true)
    expect(r.lowered).toBe(0)
  })

  it('runs once on a merged fan-out list', async () => {
    const r = await postFindingsSequentially(forge(), mergeFindings([[external], [{ ...external }]]), { filters: ctx() })
    expect(r.external).toBe(1)
  })

  it('behaves as before without filters', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [external, { ...plain, severity: 'blocking' }])
    expect(f.posted).toHaveLength(2)
    expect(f.posted[1].severity).toBe('blocking')
    expect(r.external).toBe(0)
  })
})

describe('filterOutcome', () => {
  it('records effective severities in the metadata and counts only posted findings', async () => {
    const { filterOutcome } = await import('../src/host/engine.js')
    const { buildReviewMeta } = await import('../src/host/review-marker.js')
    const thread: ThreadState = { discussionId: 'd5', path: 'a.php', line: 20, severity: 'major', lastIsHuman: false }
    const blocking: ReviewFinding = { ...plain, severity: 'blocking' }
    const reply: ReviewFinding = { status: 'reply', discussionId: 'd5', body: 'Still open.' }
    const outside: ReviewFinding = { ...external, severity: 'major', evidence: [{ path: 'a.php', line: 4 }] }
    const findings = [blocking, reply, outside]
    const r = await postFindingsSequentially(forge(), findings, { filters: ctx({ threads: [thread] }) })
    const o = filterOutcome(r, findings)
    expect(o.findings.map((f) => f.severity)).toEqual(['minor', 'major', 'major'])
    expect(o.findings[2].premise).toBe('external')
    expect(o.severityCounts).toEqual({ minor: 1, major: 2 })
    expect(o.filtered).toEqual({ external: 1, lowered: 1, answered: 0 })
    expect(o.notice).not.toContain('assumptions')
    const meta = buildReviewMeta({ headSha: 'abc123', mode: 'quick', models: [], findings: o.findings })
    expect(meta.findings.map((f) => f.severity)).toEqual(['minor', 'major', 'major'])
  })
})

describe('filterNotice', () => {
  it('names only non-zero parts', () => {
    expect(filterNotice({ lowered: 1, answered: 0, evidenceSkipped: false })).toBe('1 lowered to minor.')
    expect(filterNotice({ lowered: 0, answered: 1, evidenceSkipped: true })).toBe('1 reply to answered threads not posted. Evidence check skipped: files could not be read.')
    expect(filterNotice({ lowered: 0, answered: 0, evidenceSkipped: false })).toBe('')
  })
})

describe('linesReader', () => {
  it('counts lines in the checkout and refuses paths outside it', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { linesReader } = await import('../src/host/engine.js')
    const outer = mkdtempSync(join(tmpdir(), 'lines-'))
    const { mkdirSync } = await import('node:fs')
    const dir = join(outer, 'checkout')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.php'), 'one\ntwo\nthree\n')
    writeFileSync(join(outer, 'outside.php'), 'secret\n')
    const read = linesReader(dir, {}, 'h')!
    expect(await read('a.php')).toBe(3)
    expect(await read('missing.php')).toBeUndefined()
    expect(await read('../outside.php')).toBeUndefined()
  })

  it('refuses symlinks leaving the checkout and non-regular files, and caps the size', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { linesReader, LINES_MAX_BYTES } = await import('../src/host/engine.js')
    const outer = mkdtempSync(join(tmpdir(), 'lines-'))
    const dir = join(outer, 'checkout')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(outer, 'outside.php'), 'secret\n')
    writeFileSync(join(dir, 'a.php'), 'one\ntwo\n')
    symlinkSync(join(outer, 'outside.php'), join(dir, 'leak.php'))
    symlinkSync('/dev/zero', join(dir, 'zero.php'))
    symlinkSync('a.php', join(dir, 'alias.php'))
    writeFileSync(join(dir, 'huge.php'), Buffer.alloc(LINES_MAX_BYTES + 1, 10))
    const read = linesReader(dir, {}, 'h')!
    expect(await read('leak.php')).toBeUndefined()
    expect(await read('zero.php')).toBeUndefined()
    expect(await read('sub')).toBeUndefined()
    expect(await read('alias.php')).toBe(2)
    expect(await read('huge.php')).toBeNull()
  })

  it('reads through the forge at the head without a checkout', async () => {
    const { linesReader } = await import('../src/host/engine.js')
    const readFile = vi.fn(async (path: string, ref: string) => (path === 'a.php' && ref === 'h9' ? 'x\ny' : undefined))
    const read = linesReader(undefined, { readFile }, 'h9')!
    expect(await read('a.php')).toBe(2)
    expect(await read('b.php')).toBeUndefined()
  })

  it('tells a failed forge read (null) from an absent file (undefined)', async () => {
    const { linesReader } = await import('../src/host/engine.js')
    const read = linesReader(undefined, { readFile: async (path: string) => { if (path === 'gone.php') return undefined; throw new Error('GitLab API error 429') } }, 'h')!
    expect(await read('gone.php')).toBeUndefined()
    expect(await read('a.php')).toBeNull()
  })

  it('is undefined when nothing can read files', async () => {
    const { linesReader } = await import('../src/host/engine.js')
    expect(linesReader(undefined, {}, 'h')).toBeUndefined()
  })
})

describe('restated replies', () => {
  const versions = [{ headSha: 'h1', createdAt: '2026-11-01T00:00:00Z' }]
  const open = (over: Partial<ThreadState> = {}): ThreadState => ({ discussionId: 'd1', path: 'a.php', line: 20, severity: 'minor', currentSeverity: 'minor', lastBotAt: '2026-11-02T00:00:00Z', lastIsHuman: false, ...over })
  const reply = (severity: ReviewFinding['severity']): ReviewFinding => ({ status: 'reply', discussionId: 'd1', body: 'Still open.', severity })
  const untouched = vi.fn(async () => ({ diffs: [{ new_path: 'a.php', old_path: 'a.php', diff: '@@ -90,1 +90,1 @@\n-x\n+y\n' }] }))
  const touched = vi.fn(async () => ({ diffs: [{ new_path: 'a.php', old_path: 'a.php', diff: '@@ -19,2 +19,2 @@\n-x\n+y\n' }] }))

  it('drops a same-severity reply on unchanged code', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [reply('minor')], { filters: ctx({ threads: [open()], versions, compare: untouched }) })
    expect(f.posted).toHaveLength(0)
    expect(r.restated).toBe(1)
  })

  it('posts it when the code under the thread changed', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [reply('minor')], { filters: ctx({ threads: [open()], versions, compare: touched }) })
    expect(f.posted).toHaveLength(1)
    expect(r.restated).toBe(0)
  })

  it('posts a reply that changes the severity', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [reply('major')], { filters: ctx({ threads: [open()], versions, compare: untouched }) })
    expect(f.posted).toHaveLength(1)
    expect(r.restated).toBe(0)
  })

  it('posts it when versions cannot be read', async () => {
    const f = forge()
    await postFindingsSequentially(f, [reply('minor')], { filters: ctx({ threads: [open()], compare: untouched }) })
    expect(f.posted).toHaveLength(1)
  })

  it('compares with the current severity, not the opener', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [reply('minor')], { filters: ctx({ threads: [open({ severity: 'major', currentSeverity: 'minor' })], versions, compare: untouched }) })
    expect(f.posted).toHaveLength(0)
    expect(r.restated).toBe(1)
  })

  it('leaves answered threads to the answered filter', async () => {
    const f = forge()
    const r = await postFindingsSequentially(f, [reply('minor')], { filters: ctx({ threads: [open({ lastIsHuman: true, lastHumanAt: '2026-11-03T00:00:00Z' })], versions, compare: untouched }) })
    expect(r.answered).toBe(1)
    expect(r.restated).toBe(0)
  })

  it('records restated in the outcome and the notice', async () => {
    const { filterOutcome } = await import('../src/host/engine.js')
    const findings = [reply('minor')]
    const r = await postFindingsSequentially(forge(), findings, { filters: ctx({ threads: [open()], versions, compare: untouched }) })
    const o = filterOutcome(r, findings)
    expect(o.filtered).toEqual({ external: 0, lowered: 0, answered: 0, restated: 1 })
    expect(o.notice).toBe('1 restated reply on unchanged code not posted.')
  })
})

describe('filterNotice with restated replies', () => {
  it('counts them', () => {
    expect(filterNotice({ lowered: 0, answered: 0, restated: 2, evidenceSkipped: false })).toBe('2 restated replies on unchanged code not posted.')
  })
})
