import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCommand } from '../src/host/commands.js'
import { countDismissals, mutedCodes, findingCodeMarker } from '../src/host/review-feedback.js'
import { parseReviewMeta } from '../src/host/review-marker.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})
afterEach(() => vi.unstubAllGlobals())

describe('parseCommand dismiss', () => {
  it('reads the code and the reason from the first line only', () => {
    expect(parseCommand('/maestro dismiss SEC-XSS false positive, escaped upstream')).toEqual({ kind: 'dismiss', code: 'SEC-XSS', reason: 'false positive, escaped upstream' })
    expect(parseCommand('/maestro dismiss')).toEqual({ kind: 'dismiss' })
    expect(parseCommand('/maestro dismiss not a code')).toEqual({ kind: 'dismiss', reason: 'not a code' })
    expect(parseCommand('thanks!\n/maestro dismiss SEC-XSS')).toBeUndefined()
    expect(parseCommand('> /maestro dismiss SEC-XSS')).toBeUndefined()
  })
})

const BOT = 'maestro-bot'
const note = (author: string, body: string) => ({ author: { username: author }, body, system: false })
const thread = (code: string | undefined, ...replies: Array<[string, string]>) => ({
  notes: [note(BOT, `🔵 Minor\n\nissue${code ? `\n\n${findingCodeMarker(code)}` : ''}`), ...replies.map(([a, b]) => note(a, b))],
})

describe('countDismissals', () => {
  it('counts each code at most once per MR, from non-bot authors, resolving a bare dismiss from the thread', () => {
    const mr = [
      thread('RIG-A', ['dev', '/maestro dismiss'], ['dev2', '/maestro dismiss']),
      thread('RIG-B', ['dev', '/maestro dismiss RIG-C wrong code named']),
      thread('RIG-D', [BOT, '/maestro dismiss']),
      { notes: [note('dev', '/maestro dismiss RIG-E reason')] },
      thread(undefined, ['dev', '/maestro dismiss']),
    ]
    expect(countDismissals(mr, BOT)).toEqual(new Set(['RIG-A', 'RIG-C', 'RIG-E']))
  })
})

describe('mutedCodes', () => {
  it('mutes a code dismissed in at least threshold MRs', () => {
    expect(mutedCodes(new Map([['RIG-A', 3], ['RIG-B', 2]]))).toEqual(new Set(['RIG-A']))
    expect(mutedCodes(new Map([['RIG-B', 2]]), 2)).toEqual(new Set(['RIG-B']))
  })
})

describe('gitlab forge feedback', () => {
  it('aggregates dismissals over at most window recent MRs', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (/\/merge_requests\?/.test(url)) return new Response(JSON.stringify([1, 2, 3, 4].map((iid) => ({ iid }))), { status: 200 })
      const iid = Number(/merge_requests\/(\d+)\/discussions/.exec(url)?.[1])
      return new Response(JSON.stringify(iid <= 3 ? [thread('RIG-A', ['dev', '/maestro dismiss'])] : []), { status: 200 })
    }))
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://g', token: 't', botUsername: BOT }, { projectId: 5, mrIid: 9 })
    expect(await forge.feedback(3)).toEqual(new Map([['RIG-A', 3]]))
    expect(calls.filter((u) => u.includes('/discussions'))).toHaveLength(3)
    expect(calls[0]).toContain('per_page=3')
  })
})

describe('inline finding body', () => {
  it('shows the code and carries the hidden marker', async () => {
    const { findingNoteBody } = await import('../src/host/forge/gitlab/mr-api.js')
    const body = findingNoteBody({ status: 'new', path: 'a', line: 1, body: 'Escape it.', severity: 'minor', code: 'SEC-XSS' })
    expect(body).toContain('🔵 Minor · `SEC-XSS`')
    expect(body).toContain(findingCodeMarker('SEC-XSS'))
    expect(findingNoteBody({ status: 'new', path: 'a', line: 1, body: 'x', severity: 'minor' })).not.toContain('maestro-finding')
  })
})

describe('engine muting', () => {
  it('does not post muted codes unless blocking, names them in the comment and the metadata', async () => {
    const posted: any[] = []
    const notes: string[] = []
    const forge = {
      mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined,
      reviewScope: async () => ({ files: [{ path: 'a', bytes: 1 }], skipped: [] }), restrictToInterdiff: () => {},
      feedback: async () => new Map([['RIG-A', 4], ['RIG-B', 1]]),
      postNote: async (b: string) => { notes.push(b) }, replyToDiscussion: async () => {}, postFindings: async (fs: any[]) => { posted.push(...fs) },
      signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
    }
    const { createReviewEngine, postFindingsSequentially } = await import('../src/host/engine.js')
    const reviewer = vi.fn(async (_w: unknown, _p: unknown, run: any) => {
      const found = [
        { status: 'new', path: 'a', line: 1, body: 'x', severity: 'minor', code: 'RIG-A' },
        { status: 'new', path: 'a', line: 2, body: 'y', severity: 'blocking', code: 'RIG-A' },
        { status: 'new', path: 'a', line: 3, body: 'z', severity: 'minor', code: 'RIG-B' },
      ] as any[]
      const r = await postFindingsSequentially(run.forge, found, { muted: run.mutedCodes })
      return { summary: `${r.postedNew} new inline comment(s), 0 thread(s) updated.`, failures: [], findings: found }
    })
    await createReviewEngine({} as any, { reviewer, auditor: vi.fn() } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any },
    )
    expect(posted.map((f) => f.line)).toEqual([2, 3])
    expect(notes[0]).toContain('Muted for this project')
    expect(notes[0]).toContain('RIG-A')
    expect(parseReviewMeta(notes[0])?.muted).toEqual(['RIG-A'])
  })
})
