import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCommand } from '../src/host/commands.js'
import { buildCommandPrompt, commandMarker, findPendingCommands } from '../src/host/ci-commands.js'
import { findingCodeMarker } from '../src/host/review-feedback.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})
afterEach(() => vi.unstubAllGlobals())

describe('parseCommand', () => {
  it('reads explain, fix and rereview with an optional safe path', () => {
    expect(parseCommand('/maestro explain')).toEqual({ kind: 'explain' })
    expect(parseCommand('/maestro fix please')).toEqual({ kind: 'fix' })
    expect(parseCommand('/maestro rereview')).toEqual({ kind: 'rereview' })
    expect(parseCommand('/maestro rereview app/code/Acme/Shop/')).toEqual({ kind: 'rereview', path: 'app/code/Acme/Shop/' })
    expect(parseCommand('/maestro rereview ../etc')).toEqual({ kind: 'rereview' })
    expect(parseCommand('/maestro rereview /etc')).toEqual({ kind: 'rereview' })
    expect(parseCommand('/maestro deploy')).toBeUndefined()
  })
})

const BOT_ID = 7
const n = (id: number, authorId: number, body: string, extra: Record<string, unknown> = {}) => ({ id, author: { id: authorId, username: authorId === BOT_ID ? 'bot' : `u${authorId}` }, body, system: false, ...extra })
const finding = (id: number) => n(id, BOT_ID, `🟡 Major · \`SEC-XSS\`\n\nUnescaped output.\n\n${findingCodeMarker('SEC-XSS')}`, { position: { new_path: 'a.phtml', new_line: 12 } })

function stub(discussions: unknown[], access: Record<number, number>) {
  return vi.fn(async (url: string) => {
    if (url.includes('/discussions?')) return new Response(JSON.stringify(new URL(url).searchParams.get('page') === '1' ? discussions : []), { status: 200, headers: { 'x-next-page': '' } })
    const m = /members\/all\/(\d+)$/.exec(url)
    if (m) return access[Number(m[1])] === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ access_level: access[Number(m[1])] }), { status: 200 })
    return new Response('[]', { status: 200 })
  })
}

describe('findPendingCommands', () => {
  it('keeps unanswered commands by developers, with the bot thread finding they reply to', async () => {
    const fetcher = stub([
      { id: 'd1', notes: [finding(1), n(2, 30, '/maestro fix')] },
      { id: 'd2', notes: [finding(3), n(4, 30, '/maestro explain'), n(5, BOT_ID, `answer\n\n${commandMarker(4)}`)] },
      { id: 'd3', notes: [finding(6), n(7, 40, '/maestro explain')] },
      { id: 'd4', notes: [n(8, 30, '/maestro rereview app/')] },
      { id: 'd5', notes: [n(9, 30, 'I think\n/maestro rereview')] },
      { id: 'd6', notes: [n(10, BOT_ID, '/maestro rereview')] },
      { id: 'd7', notes: [n(11, 30, '/maestro explain')] },
    ], { 30: 30, 40: 20 })
    const pending = await findPendingCommands(fetcher as any, { baseUrl: 'https://g', token: 't', projectId: 1, mrIid: 2, botUserId: BOT_ID })
    expect(pending).toEqual([
      { noteId: 2, discussionId: 'd1', command: { kind: 'fix' }, finding: { path: 'a.phtml', line: 12, code: 'SEC-XSS', body: expect.stringContaining('Unescaped output.') } },
      { noteId: 8, discussionId: 'd4', command: { kind: 'rereview', path: 'app/' } },
      { noteId: 11, discussionId: 'd7', command: { kind: 'explain' } },
    ])
  })
})

describe('buildCommandPrompt', () => {
  const f = { path: 'a.phtml', line: 12, code: 'SEC-XSS', body: 'Unescaped output.' }
  it('asks for one GitLab suggestion block on the thread line for fix, an explanation for explain', () => {
    const fix = buildCommandPrompt({ kind: 'fix' }, f)
    expect(fix).toContain('```suggestion:-0+0')
    expect(fix).toContain('a.phtml:12')
    expect(fix).toMatch(/never push/i)
    expect(buildCommandPrompt({ kind: 'explain' }, f)).toContain('Unescaped output.')
    expect(fix).toMatch(/untrusted/i)
  })
})

describe('ci trigger with pending commands', () => {
  const run = async (discussions: unknown[]) => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const posts: Array<{ url: string; body: any; method: string }> = []
    const meta = (await import('../src/host/review-marker.js')).encodeReviewMeta({ v: 1, headSha: 'abc', mode: 'quick', models: [], findings: [], at: 't' })
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') !== 'GET') { posts.push({ url, method: init.method!, body: JSON.parse(String(init.body ?? '{}')) }); return new Response('{}', { status: 201 }) }
      if (url.endsWith('/user')) return new Response(JSON.stringify({ id: BOT_ID }), { status: 200 })
      if (url.includes('/discussions?')) return new Response(JSON.stringify(new URL(url).searchParams.get('page') === '1' ? discussions : []), { status: 200, headers: { 'x-next-page': '' } })
      if (url.includes('/members/all/')) return new Response(JSON.stringify({ access_level: 30 }), { status: 200 })
      if (url.includes('/notes')) return new Response(JSON.stringify([{ author: { id: BOT_ID }, body: meta }]), { status: 200 })
      if (url.includes('/repository/files/')) return new Response('', { status: 404 })
      if (url.includes('/award_emoji')) return new Response('[]', { status: 200 })
      return new Response(JSON.stringify({ source_branch: 'b', target_branch: 'main', sha: 'abc' }), { status: 200 })
    })
    const engine = { run: vi.fn(async () => ({ ok: true, summary: 'reviewed', failures: [], durationMs: 1 })), answer: vi.fn(async () => 'Here is the fix.\n```suggestion:-0+0\n<?= $escaper->escapeHtml($x) ?>\n```') }
    const result = await runCiTrigger({ reviewEngine: engine } as any, cfg, { fetcher: fetcher as any, writeFile: (async () => {}) as any })
    return { engine, posts, result }
  }

  it('answers a fix in its thread with the marker, writes nothing but notes, and leaves the push-gate in place', async () => {
    const { engine, posts, result } = await run([{ id: 'd1', notes: [finding(1), n(2, 30, '/maestro fix')] }])
    expect(engine.answer).toHaveBeenCalledTimes(1)
    expect((engine.answer.mock.calls[0] as any[])[2]).toContain('a.phtml:12')
    expect(engine.run).not.toHaveBeenCalled()
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toMatch(/\/merge_requests\/2\/discussions\/d1\/notes$/)
    expect(posts[0].body.body).toContain('```suggestion:-0+0')
    expect(posts[0].body.body).toContain(commandMarker(2))
    expect(result.summary).toMatch(/1 command/)
  })

  it('answers a command outside a finding thread with a usage hint and no agent', async () => {
    const { engine, posts } = await run([{ id: 'd7', notes: [n(11, 30, '/maestro explain')] }])
    expect(engine.answer).not.toHaveBeenCalled()
    expect(posts[0].body.body).toMatch(/reply .*inside a review finding thread/i)
  })

  it('runs a rereview limited to its path past the push-gate, then replies', async () => {
    const { engine, posts } = await run([{ id: 'd4', notes: [n(8, 30, '/maestro rereview app/code/')] }])
    expect(engine.run).toHaveBeenCalledTimes(1)
    expect((engine.run.mock.calls[0] as any[])[0]).toMatchObject({ pathPrefix: 'app/code/' })
    expect(posts.find((p) => p.url.endsWith('/discussions/d4/notes'))?.body.body).toContain(commandMarker(8))
  })
})

describe('forge path restriction', () => {
  it('serves only files under the rereview path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => /\/diffs\?/.test(url) && new URL(url).searchParams.get('page') === '1'
      ? new Response(JSON.stringify([{ old_path: 'app/code/A.php', new_path: 'app/code/A.php', diff: 'x' }, { old_path: 'lib/B.php', new_path: 'lib/B.php', diff: 'y' }]), { status: 200, headers: { 'x-next-page': '' } })
      : new Response('[]', { status: 200 })))
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://g', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 }, { pathPrefix: 'app/code/' })
    expect((await forge.reviewScope()).files.map((f) => f.path)).toEqual(['app/code/A.php'])
  })
})

describe('a path-limited rereview never weakens the gate', () => {
  const runWith = async (priorHead: string, priorSeverity: string, command: string) => {
    const { parseCiEnvConfig, runCiTrigger, ciExitCode } = await import('../src/host/providers/ci-trigger.js')
    const { encodeReviewMeta } = await import('../src/host/review-marker.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', REVIEW_GATE: 'blocking', REVIEW_ON_PUSH: '1' })
    const meta = encodeReviewMeta({ v: 1, headSha: priorHead, mode: 'quick', models: [], findings: [{ code: 'SEC-X', fingerprint: 'fp1', severity: priorSeverity }], at: 't' })
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') !== 'GET') return new Response('{}', { status: 201 })
      if (url.endsWith('/user')) return new Response(JSON.stringify({ id: BOT_ID }), { status: 200 })
      if (url.includes('/discussions?')) return new Response(JSON.stringify(new URL(url).searchParams.get('page') === '1' ? [{ id: 'd4', notes: [n(8, 30, command)] }] : []), { status: 200, headers: { 'x-next-page': '' } })
      if (url.includes('/members/all/')) return new Response(JSON.stringify({ access_level: 30 }), { status: 200 })
      if (url.includes('/notes')) return new Response(JSON.stringify([{ author: { id: BOT_ID }, body: meta }]), { status: 200 })
      if (url.includes('/repository/files/')) return new Response('', { status: 404 })
      if (url.includes('/award_emoji')) return new Response('[]', { status: 200 })
      return new Response(JSON.stringify({ source_branch: 'b', target_branch: 'main', sha: 'abc' }), { status: 200 })
    })
    const engine = { run: vi.fn(async () => ({ ok: true, summary: 'reviewed', failures: [], durationMs: 1, findings: [] })), answer: vi.fn() }
    const result = await runCiTrigger({ reviewEngine: engine } as any, cfg, { fetcher: fetcher as any, writeFile: (async () => {}) as any })
    return { engine, code: ciExitCode(result, cfg) }
  }

  it('carries the full review of the same head into the gate and the metadata', async () => {
    const { engine, code } = await runWith('abc', 'blocking', '/maestro rereview lib/')
    expect(code).toBe(3)
    const [req, opts] = engine.run.mock.calls[0] as any[]
    expect(req.pathPrefix).toBe('lib/')
    expect(opts.carryFindings).toEqual([{ code: 'SEC-X', fingerprint: 'fp1', severity: 'blocking' }])
  })

  it('reviews the whole MR when no full review of this head exists', async () => {
    const { engine } = await runWith('old', 'blocking', '/maestro rereview lib/')
    expect((engine.run.mock.calls[0] as any[])[0].pathPrefix).toBeUndefined()
  })
})

describe('engine metadata of a path-limited review', () => {
  it('is partial and keeps the carried findings', async () => {
    const { parseReviewMeta } = await import('../src/host/review-marker.js')
    const notes: string[] = []
    const forge = {
      mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined, restrictToInterdiff: () => {}, feedback: async () => new Map(),
      reviewScope: async () => ({ files: [{ path: 'lib/a.php', bytes: 1 }], skipped: [] }),
      postNote: async (b: string) => { notes.push(b) }, replyToDiscussion: async () => {}, postFindings: async () => {},
      signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
    }
    const { createReviewEngine } = await import('../src/host/engine.js')
    await createReviewEngine({} as any, { reviewer: vi.fn(async () => ({ summary: 'ok', failures: [], findings: [{ status: 'new', path: 'lib/a.php', line: 1, body: 'b', severity: 'minor', code: 'RIG-L' }] })), auditor: vi.fn() } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' }, pathPrefix: 'lib/' } as any,
      { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any, carryFindings: [{ code: 'SEC-X', fingerprint: 'fp1', severity: 'blocking' }] },
    )
    const meta = parseReviewMeta(notes[0])!
    expect(meta.partial).toBe(true)
    expect(meta.findings.map((f) => f.code).sort()).toEqual(['RIG-L', 'SEC-X'])
  })
})
