import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planChunks, MAX_PARTS } from '../src/host/chunking.js'
import { mergeFindings } from '../src/host/merge-findings.js'
import { planIncremental } from '../src/host/incremental.js'
import { encodeReviewMeta, parseReviewMeta } from '../src/host/review-marker.js'
import { reviewerPromptParts } from '../src/host/orchestrator.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})
afterEach(() => vi.unstubAllGlobals())

describe('fan-out parts write their own diff spill', () => {
  it('two parts in one workspace never share the spill file', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => /\/diffs\?/.test(url) && new URL(url).searchParams.get('page') === '1'
      ? new Response(JSON.stringify([{ old_path: 'a.php', new_path: 'a.php', diff: 'AAA' }, { old_path: 'b.php', new_path: 'b.php', diff: 'BBB' }]), { status: 200, headers: { 'x-next-page': '' } })
      : new Response('[]', { status: 200 })))
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 })
    const cwd = mkdtempSync(join(tmpdir(), 'spill-'))
    const exec = { agent: { session: { header: { cwd } } } }
    const mount = async (onlyPaths: string[], partLabel: string) => {
      const tools: Array<{ name: string; execute: (a: any, e?: any) => Promise<any> }> = []
      await forge.mountAgentTools({ plugin: async (mod: any, cfg: any) => mod.apply({ tools: { register: (t: any) => tools.push(t) } }, cfg) } as any, { onlyPaths, partLabel })
      return tools.find((t) => t.name === 'gitlab_get_mr_diff')!
    }
    const r1 = await (await mount(['a.php'], 'high-1')).execute({}, exec)
    const r2 = await (await mount(['b.php'], 'high-2')).execute({}, exec)
    expect(r1.path).not.toBe(r2.path)
    expect(readFileSync(join(cwd, r1.path), 'utf8')).toContain('AAA')
    expect(readFileSync(join(cwd, r1.path), 'utf8')).not.toContain('BBB')
  })
})

describe('deep requests and partial reviews never shrink to an interdiff', () => {
  it('a prior review that did not cover every file forces a full review', () => {
    const compare = { diffs: [{ old_path: 'a.php', new_path: 'a.php', diff: 'x' }] }
    expect(planIncremental({ headSha: 'a', baseSha: 'b', partial: true }, { headSha: 'c', baseSha: 'b' }, compare)).toEqual({ kind: 'full', reason: 'prior review partial' })
  })

  it('the metadata round-trips the partial flag', () => {
    const meta = parseReviewMeta(encodeReviewMeta({ v: 1, headSha: 'abc', mode: 'quick', models: [], findings: [], partial: true, at: 'x' }))
    expect(meta?.partial).toBe(true)
  })

  const compare = { commits: [], diffs: [{ old_path: 'a.php', new_path: 'a.php', diff: 'x' }] }
  const forge = (restricted: unknown[], notes: string[], scopeFiles = [{ path: 'a.php', bytes: 1 }]) => ({
    mrHeadSha: async () => 'c0ffee', mrBaseSha: async () => 'b1', compare: async () => compare,
    reviewScope: async () => ({ files: scopeFiles, skipped: [] }), restrictToInterdiff: (f: unknown) => { restricted.push(f) },
    postNote: async (b: string) => { notes.push(b) }, replyToDiscussion: async () => {}, postFindings: async () => {},
    signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
  })
  const run = async (mode: 'quick' | 'deep', reviewer: (...a: any[]) => Promise<any>, extra: Record<string, unknown> = {}, scopeFiles?: Array<{ path: string; bytes: number }>) => {
    const { createReviewEngine } = await import('../src/host/engine.js')
    const restricted: unknown[] = []
    const notes: string[] = []
    const r = await createReviewEngine({} as any, { reviewer: vi.fn(reviewer), auditor: vi.fn(async () => 'audit') } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'c0ffee', priorHeadSha: 'abc0', priorBaseSha: 'b1', trigger: 'mention', mode, scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge(restricted, notes, scopeFiles) as any, ...extra },
    )
    return { r, restricted, notes }
  }

  it('a deep request reviews the whole MR', async () => {
    expect((await run('deep', async () => ({ summary: 'ok', failures: [] }))).restricted).toEqual([])
    expect((await run('quick', async () => ({ summary: 'ok', failures: [] }))).restricted).toHaveLength(1)
  })

  it('a review with a failed part records partial coverage', async () => {
    let n = 0
    const many = Array.from({ length: 4 }, (_, i) => ({ path: `src/M${i}/a.php`, bytes: 1 }))
    const { notes } = await run('quick', async (_w, _p, _r, _pr, _b, chunk) => {
      if (n++ === 0) throw new Error('timeout')
      return { summary: '', failures: [], findings: [], models: ['m'], deferredPost: true, chunk }
    }, { fanout: { files: 1, bytes: 1_000_000, concurrency: 2 } }, many)
    expect(parseReviewMeta(notes[0])?.partial).toBe(true)
  })
})

describe('fan-out is bounded and opt-in', () => {
  it('never plans more than MAX_PARTS parts', () => {
    const files = Array.from({ length: 400 }, (_, i) => ({ path: `src/M${i % 40}/f${i}.phtml`, bytes: 100 }))
    const chunks = planChunks(files, { files: 25, bytes: 150_000 })
    expect(chunks.length).toBeLessThanOrEqual(MAX_PARTS)
    expect(chunks.flatMap((c) => c.files)).toHaveLength(400)
  })

  it('an engine caller that passes no fanout gets one reviewer, whatever the size', async () => {
    const { createReviewEngine } = await import('../src/host/engine.js')
    const chunks: unknown[] = []
    const big = Array.from({ length: 60 }, (_, i) => ({ path: `src/M${i}/a.php`, bytes: 10 }))
    await createReviewEngine({} as any, { reviewer: vi.fn(async (_w: unknown, _p: unknown, _r: unknown, _pr: unknown, _b: unknown, c: unknown) => { chunks.push(c); return { summary: 'ok', failures: [] } }), auditor: vi.fn() } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'c0ffee', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000,
        forge: { mrHeadSha: async () => 'c0ffee', mrBaseSha: async () => 'b1', compare: async () => undefined, reviewScope: async () => ({ files: big, skipped: [] }), restrictToInterdiff: () => {}, postNote: async () => {}, replyToDiscussion: async () => {}, postFindings: async () => {}, signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {} } as any },
    )
    expect(chunks).toEqual([undefined])
  })

  it('a part prompt never carries the whole-MR lint rule', () => {
    const parts = reviewerPromptParts({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: { worktreePath: '/w', base: 'b' }, part: { label: 'high-1', files: ['a.php'] } })
    expect(parts.dynamic.join('')).not.toContain('LINT RULE')
  })
})

describe('merged replies', () => {
  it('keep one reply per discussion and never collapse replies to different discussions', () => {
    const r = (discussionId: string, body: string, severity: 'minor' | 'major' = 'minor') => ({ status: 'reply' as const, discussionId, body, severity })
    const merged = mergeFindings([[r('d1', 'Still present.'), r('d2', 'Still present.')], [r('d1', 'Still not fixed.', 'major')]])
    expect(merged.map((f) => f.discussionId).sort()).toEqual(['d1', 'd2'])
    expect(merged.find((f) => f.discussionId === 'd1')?.severity).toBe('major')
  })
})
