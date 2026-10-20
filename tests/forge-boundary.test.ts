import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => ({ headSha: 'old' })) }
})

function fakeForge() {
  const calls: string[] = []
  const forge = {
    mrHeadSha: vi.fn(async () => { calls.push('mrHeadSha'); return 'new' }),
    mrBaseSha: vi.fn(async () => { calls.push('mrBaseSha'); return 'base' }),
    compare: vi.fn(async (from: string, to: string) => { calls.push(`compare ${from}..${to}`); return { commits: [{ short_id: 'c1', title: 'x' }], diffs: [{ new_path: 'a.php' }] } }),
    postNote: vi.fn(async () => { calls.push('postNote') }),
    replyToDiscussion: vi.fn(async () => { calls.push('replyToDiscussion') }),
    postFindings: vi.fn(async () => { calls.push('postFindings') }),
    signals: vi.fn(() => ({ start: async () => { calls.push('signals.start') }, finish: async (s: string) => { calls.push(`signals.finish ${s}`) } })),
    mountAgentTools: vi.fn(async () => {}),
  }
  return { forge, calls }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('forge boundary', () => {
  it('the engine runs a diff review through the forge alone, with no request of its own', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('the engine must not call fetch') })
    vi.stubGlobal('fetch', fetchSpy)
    const { createReviewEngine } = await import('../src/host/engine.js')
    const reviewer = vi.fn(async () => ({ summary: '1 new inline comment(s).', failures: [] }))
    const engine = createReviewEngine({} as any, { reviewer, auditor: vi.fn() } as any)
    const { forge, calls } = fakeForge()
    const r = await engine.run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'new', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any },
    )
    expect(r.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls).toEqual(['mrHeadSha', 'compare old..new', 'signals.start', 'postNote', 'signals.finish completed'])
    // The agents get a timing wrapper of this forge, never a forge of their own.
    const agentForge = ((reviewer.mock.calls[0] as unknown[])[2] as { forge: typeof forge }).forge
    calls.length = 0
    await agentForge.postFindings([] as any)
    await agentForge.mountAgentTools({} as any, {})
    expect(calls).toEqual(['postFindings'])
    expect(forge.mountAgentTools).toHaveBeenCalledTimes(1)
  })

  it('only the forge and the CI modules build GitLab REST URLs', () => {
    const root = 'src/host'
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(root)
    const offenders = files
      .filter(f => !relative(root, f).startsWith('forge/') && !basename(f).startsWith('ci-'))
      .filter(f => readFileSync(f, 'utf-8').includes('/api/v4/'))
    expect(offenders).toEqual([])
  })

  it('gitlabForge implements every forge call', async () => {
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 })
    for (const k of ['mrHeadSha', 'mrBaseSha', 'compare', 'postNote', 'replyToDiscussion', 'postFindings', 'signals', 'mountAgentTools']) {
      expect(typeof (forge as unknown as Record<string, unknown>)[k], k).toBe('function')
    }
  })
})
