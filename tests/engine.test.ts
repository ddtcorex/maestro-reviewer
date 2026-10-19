import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/host/ci-clone.js', () => ({
  cloneSourceRepo: vi.fn(async (opts: any) => opts.dir),
  defaultRun: vi.fn(async () => {}),
  redactCloneUrl: (u: string) => u,
}))
vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return {
    ...mod,
    recordReviewStart: vi.fn(async () => {}),
    recordReviewFinish: vi.fn(async () => {}),
    lastCompletedReview: vi.fn(async () => undefined),
  }
})

const payload = (o: Record<string, unknown> = {}) => ({
  projectPath: 'group/proj', projectId: 1, mrIid: 2, sourceBranch: 'feat/x', headSha: 'abc123',
  trigger: 'mention', mode: 'quick', scope: { kind: 'mr' }, ...o,
}) as any

const gitlab = { baseUrl: 'https://gitlab.example.com', token: 't', botUsername: 'bot' }
const model = { provider: 'p', model: 'm' } as any

function fakeAgents() {
  const reviewerPaths: Array<string | undefined> = []
  return {
    reviewerPaths,
    agents: {
      reviewer: vi.fn(async (worktreePath: string | undefined) => { reviewerPaths.push(worktreePath); return { summary: '1 new inline comment(s).', failures: [] } }),
      auditor: vi.fn(async () => '## Maestro Performance Audit\n\nok'),
    },
  }
}

let notePosts: string[]
beforeEach(async () => {
  notePosts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? 'GET') === 'POST' && /\/notes$/.test(url)) notePosts.push(url)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  const history = await import('../src/host/review-history.js')
  vi.mocked(history.recordReviewStart).mockClear()
  vi.mocked(history.recordReviewFinish).mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GITLAB_HOST })

async function engineWith(agents: any) {
  const { createReviewEngine } = await import('../src/host/engine.js')
  return createReviewEngine({} as any, agents)
}

describe('review engine', () => {
  it('diff: reviews without a worktree and posts exactly one comment', async () => {
    const { agents, reviewerPaths } = fakeAgents()
    const engine = await engineWith(agents)
    const r = await engine.run(payload(), { gitlab, access: { kind: 'diff' }, model, agentTimeoutMs: 1000 })
    expect(r.ok).toBe(true)
    expect(reviewerPaths).toEqual([undefined])
    expect(notePosts).toHaveLength(1)
  })

  it('clone: clones from the given host and never reads GITLAB_HOST', async () => {
    process.env.GITLAB_HOST = 'env.example.com'
    const { cloneSourceRepo } = await import('../src/host/ci-clone.js')
    vi.mocked(cloneSourceRepo).mockClear()
    const { agents } = fakeAgents()
    const engine = await engineWith(agents)
    await engine.run(payload({ mode: 'deep' }), { gitlab, access: { kind: 'clone', host: 'clone.example.com' }, model, agentTimeoutMs: 1000 })
    expect(cloneSourceRepo).toHaveBeenCalledWith(expect.objectContaining({ host: 'clone.example.com', headSha: 'abc123', token: 't' }))
  })

  it('workspace: a missing branch falls back to diff and records the fallback summary', async () => {
    const history = await import('../src/host/review-history.js')
    const { agents, reviewerPaths } = fakeAgents()
    const engine = await engineWith(agents)
    const missing = Object.assign(new Error('no such branch'), { code: 'BRANCH_NOT_FOUND' })
    const r = await engine.run(payload(), {
      gitlab, model, agentTimeoutMs: 1000,
      access: { kind: 'workspace', localRepoPath: '/repo', ensureWorktree: async () => { throw missing }, removeWorktree: async () => {}, auditor: 'runtime' },
    })
    expect(r.ok).toBe(true)
    expect(r.summary).toMatch(/^fallback diff-only: branch feat\/x not found/)
    expect(reviewerPaths).toEqual([undefined])
    expect(vi.mocked(history.recordReviewFinish).mock.calls[0][1]).toMatchObject({ status: 'completed', summary: expect.stringMatching(/^fallback diff-only/) })
  })

  it('records one history start and one finish per run, and notifies once with the final status', async () => {
    const history = await import('../src/host/review-history.js')
    const notify = vi.fn()
    const failing = { reviewer: vi.fn(async () => { throw new Error('boom') }), auditor: vi.fn() }
    const engine = await engineWith(failing)
    const r = await engine.run(payload(), { gitlab, access: { kind: 'diff' }, model, agentTimeoutMs: 1000, notify })
    expect(r.ok).toBe(false)
    expect(history.recordReviewStart).toHaveBeenCalledTimes(1)
    expect(history.recordReviewFinish).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('failed', 'boom')
  })

  it('passes the explicit model to the agent runners', async () => {
    const { agents } = fakeAgents()
    const engine = await engineWith(agents)
    await engine.run(payload(), { gitlab, access: { kind: 'diff' }, model, agentTimeoutMs: 1234 })
    const call = agents.reviewer.mock.calls[0] as unknown[]
    expect(call[0]).toBeUndefined()
    expect(call[2]).toMatchObject({ model, agentTimeoutMs: 1234, gitlab })
  })
})

describe('toModelSelection', () => {
  it('builds a selection from plain settings values, keeping the reasoning effort only when set', async () => {
    const { toModelSelection } = await import('../src/host/engine.js')
    expect(toModelSelection({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
    expect(toModelSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})
