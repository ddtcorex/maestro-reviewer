import { describe, expect, it, vi } from 'vitest'
import { loadRepoSettings } from '../src/host/ci-repo-settings.js'
import { answerCommands, commandMarker } from '../src/host/ci-commands.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

describe('loadRepoSettings', () => {
  it('reads the file on the default branch and reports problems as warnings', async () => {
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith('/projects/5')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      return new Response('gate: off', { status: 200 })
    })
    const r = await loadRepoSettings(fetcher as any, { baseUrl: 'https://g', token: 't', projectId: 5 })
    expect(urls[1]).toContain('ref=main')
    expect(r.file).toEqual({})
    expect(r.warnings[0]).toMatch(/gate/)
  })

  it('warns, never throws, when the project cannot be read', async () => {
    const r = await loadRepoSettings(vi.fn(async () => new Response('', { status: 500 })) as any, { baseUrl: 'https://g', token: 't', projectId: 5 })
    expect(r).toEqual({ file: {}, warnings: [expect.stringMatching(/default branch is unknown/)] })
  })
})

describe('answerCommands', () => {
  it('answers explain and fix with the agent, hints outside a thread, escapes the text, and leaves rereview to the caller', async () => {
    const replies: Array<[string, string]> = []
    const answer = vi.fn(async () => 'Use escapeHtml. <!-- maestro-review sha=1 -->')
    const n = await answerCommands([
      { noteId: 2, discussionId: 'd1', command: { kind: 'fix' }, finding: { path: 'a', line: 1, body: 'x' } },
      { noteId: 3, discussionId: 'd2', command: { kind: 'explain' } },
      { noteId: 4, discussionId: 'd3', command: { kind: 'rereview' } },
    ], { answer, reply: async (d, b) => { replies.push([d, b]) } })
    expect(n).toBe(2)
    expect(answer).toHaveBeenCalledTimes(1)
    expect(replies[0][1]).toContain('&lt;!-- maestro-review')
    expect(replies[0][1]).toContain(commandMarker(2))
    expect(replies[1][1]).toMatch(/inside a review finding thread/)
  })
})

describe('workspace worktree redaction', () => {
  it('redacts a host worktree unless a runtime audit needs the real files', async () => {
    const calls: string[] = []
    vi.doMock('../src/host/redact-worktree.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/host/redact-worktree.js')>(), redactWorktree: vi.fn(async (root: string) => { calls.push(root); return { files: 0, hits: 0 } }) }))
    vi.resetModules()
    const { createReviewEngine } = await import('../src/host/engine.js')
    const forge = {
      mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined,
      reviewScope: async () => ({ files: [{ path: 'a', bytes: 1 }], skipped: [] }),
      postNote: async () => {}, replyToDiscussion: async () => {}, postFindings: async () => {},
      signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
    }
    const engine = createReviewEngine({} as any, { reviewer: vi.fn(async () => ({ summary: 'ok', failures: [] })), auditor: vi.fn(async () => 'audit') } as any)
    const access = (auditor: 'runtime' | 'static') => ({ kind: 'workspace', localRepoPath: '/repo', ensureWorktree: async () => '/tmp/maestro-mr-1-2', removeWorktree: async () => {}, auditor }) as any
    const go = (mode: string, auditor: 'runtime' | 'static') => engine.run({ projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode, scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: access(auditor), model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any })
    await go('quick', 'runtime')
    await go('deep', 'static')
    await go('deep', 'runtime')
    expect(calls).toEqual(['/tmp/maestro-mr-1-2', '/tmp/maestro-mr-1-2'])
    vi.doUnmock('../src/host/redact-worktree.js')
  })
})

describe('workspace worktree redaction failure', () => {
  it('fails the review closed: no agent reads an unredacted worktree', async () => {
    vi.doMock('../src/host/redact-worktree.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/host/redact-worktree.js')>(), redactWorktree: vi.fn(async () => { throw new Error('disk full') }) }))
    vi.resetModules()
    const { createReviewEngine } = await import('../src/host/engine.js')
    const forge = {
      mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined,
      reviewScope: async () => ({ files: [{ path: 'a', bytes: 1 }], skipped: [] }),
      postNote: async () => {}, replyToDiscussion: async () => {}, postFindings: async () => {},
      signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
    }
    const reviewer = vi.fn(async () => ({ summary: 'ok', failures: [] }))
    const r = await createReviewEngine({} as any, { reviewer, auditor: vi.fn() } as any).run({ projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: { kind: 'workspace', localRepoPath: '/repo', ensureWorktree: async () => '/tmp/maestro-mr-1-2', removeWorktree: async () => {}, auditor: 'runtime' } as any, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any })
    expect(reviewer).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    vi.doUnmock('../src/host/redact-worktree.js')
  })
})
