import { afterEach, describe, expect, it, vi } from 'vitest'
import { groupKey, planChunks, runWithConcurrency } from '../src/host/chunking.js'
import { mergeFindings } from '../src/host/merge-findings.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

const T = { files: 10, bytes: 10_000 }
const f = (path: string, bytes = 100) => ({ path, bytes })

describe('groupKey', () => {
  it('groups Magento code by module and everything else by its first two segments', () => {
    expect(groupKey('app/code/Acme/Shop/Model/A.php')).toBe('app/code/Acme/Shop')
    expect(groupKey('app/design/frontend/Acme/theme/web/a.js')).toBe('app/design/frontend/Acme')
    expect(groupKey('src/Service/A.php')).toBe('src/Service')
    expect(groupKey('README.md')).toBe('.')
  })
})

describe('planChunks', () => {
  it('keeps an MR under both thresholds in one chunk', () => {
    const chunks = planChunks([f('a/b/A.php'), f('c/d/x.phtml')], T)
    expect(chunks).toEqual([{ id: 'all', files: ['a/b/A.php', 'c/d/x.phtml'], risk: 'low' }])
  })

  it('splits a large MR into chunks within the thresholds, high risk files apart', () => {
    const files = [
      ...Array.from({ length: 15 }, (_, i) => f(`app/code/Acme/Shop/view/frontend/templates/t${i}.phtml`)),
      ...Array.from({ length: 15 }, (_, i) => f(`app/code/Acme/Shop/Model/M${i}.php`)),
      f('app/code/Acme/Shop/etc/di.xml'),
    ]
    const chunks = planChunks(files, T)
    expect(chunks.flatMap((c) => c.files).sort()).toEqual(files.map((x) => x.path).sort())
    for (const c of chunks) expect(c.files.length).toBeLessThanOrEqual(T.files)
    expect(chunks.find((c) => c.files.includes('app/code/Acme/Shop/etc/di.xml'))?.risk).toBe('high')
    expect(chunks.find((c) => c.files.includes('app/code/Acme/Shop/view/frontend/templates/t0.phtml'))?.risk).toBe('low')
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length)
  })

  it('cuts by bytes too, but never splits a single file', () => {
    const chunks = planChunks([f('src/A/a.php', 9_000), f('src/A/b.php', 9_000), f('src/A/huge.php', 50_000)], T)
    expect(chunks.map((c) => c.files)).toEqual([['src/A/a.php'], ['src/A/b.php'], ['src/A/huge.php']])
  })
})

describe('runWithConcurrency', () => {
  it('never runs more than the limit at once and settles every task in order', async () => {
    let running = 0
    let peak = 0
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      running++; peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (i === 3) throw new Error('boom')
      return i
    })
    const out = await runWithConcurrency(tasks, 3)
    expect(peak).toBe(3)
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
  })
})

describe('mergeFindings', () => {
  it('dedupes by fingerprint across chunks and keeps the highest severity', () => {
    const a = { status: 'new' as const, path: 'x.php', line: 3, body: 'Same  issue', code: 'SEC-X', severity: 'minor' as const }
    const b = { ...a, body: 'Same issue', line: 4, severity: 'major' as const }
    const c = { status: 'new' as const, path: 'y.php', line: 1, body: 'Other', severity: 'nit' as const }
    expect(mergeFindings([[a, c], [b]])).toEqual([{ ...a, severity: 'major' }, c])
  })
})

afterEach(() => vi.unstubAllGlobals())

const many = Array.from({ length: 30 }, (_, i) => ({ path: i < 3 ? `app/code/Acme/Shop/etc/x${i}/di.xml` : `app/code/Acme/Shop/view/t${i}.phtml`, bytes: 100 }))

function fanForge() {
  const posted: unknown[] = []
  const notes: string[] = []
  const forge = {
    mrHeadSha: async () => 'abc1', mrBaseSha: async () => 'b1', compare: async () => undefined,
    reviewScope: async () => ({ files: many, skipped: [] }), restrictToInterdiff: () => {},
    postNote: async (b: string) => { notes.push(b) }, replyToDiscussion: async () => {},
    postFindings: async (fs: unknown[]) => { posted.push(...fs) },
    signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
  }
  return { forge, posted, notes }
}

async function runFanout(reviewer: (...a: any[]) => Promise<any>, extra: Record<string, unknown> = {}) {
  const { createReviewEngine } = await import('../src/host/engine.js')
  const f = fanForge()
  const r = await createReviewEngine({} as any, { reviewer: vi.fn(reviewer), auditor: vi.fn() } as any).run(
    { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc1', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
    { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'fast' } as any,
      agentTimeoutMs: 1000, forge: f.forge as any, fanout: { files: 10, bytes: 1_000_000, concurrency: 2 }, ...extra },
  )
  return { ...f, r }
}

const finding = (path: string, body = `issue in ${path}`) => ({ status: 'new', path, line: 1, body, severity: 'minor' })

describe('engine fan-out', () => {
  it('reviews each chunk with its own file allowlist, posts the merged findings once, and routes high risk chunks to the deep model', async () => {
    const calls: Array<{ files: string[]; model: string; label: string }> = []
    const { posted, notes, r } = await runFanout(async (_w, _p, run, _prof, _blk, chunk) => {
      calls.push({ files: chunk.files, model: run.model.model, label: chunk.label })
      return { summary: '', failures: [], findings: [finding(chunk.files[0]), finding('shared.php', 'dup')], models: [run.model.model], deferredPost: true }
    }, { deepModel: { provider: 'p', model: 'strong' } })
    expect(r.ok).toBe(true)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.flatMap((c) => c.files).sort()).toEqual(many.map((m) => m.path).sort())
    expect(calls.find((c) => c.files.some((p) => p.endsWith('di.xml')))?.model).toBe('strong')
    expect(calls.find((c) => c.files.some((p) => p.endsWith('.phtml')))?.model).toBe('fast')
    expect(posted).toHaveLength(calls.length + 1)
    expect(notes[0]).toMatch(/Reviewed in \d+ parallel parts/)
  })

  it('posts the partial result naming a failed chunk, and fails the review only when every chunk fails', async () => {
    let n = 0
    const partial = await runFanout(async (_w, _p, _run, _prof, _blk, chunk) => {
      if (n++ === 0) throw new Error('model timeout')
      return { summary: '', failures: [], findings: [finding(chunk.files[0])], models: ['fast'], deferredPost: true }
    })
    expect(partial.r.ok).toBe(true)
    expect(partial.notes[0]).toMatch(/Part \S+ \(\d+ files\) failed: model timeout/)
    const all = await runFanout(async () => { throw new Error('provider down') })
    expect(all.r.ok).toBe(false)
    expect(all.r.failures[0]).toMatch(/every review part failed: provider down/)
  })

  it('leaves an MR under the thresholds to one reviewer run with no allowlist', async () => {
    const chunks: unknown[] = []
    const { r } = await runFanout(async (_w, _p, _run, _prof, _blk, chunk) => { chunks.push(chunk); return { summary: 'ok', failures: [] } }, { fanout: { files: 100, bytes: 1_000_000, concurrency: 2 } })
    expect(r.ok).toBe(true)
    expect(chunks).toEqual([undefined])
  })
})

describe('gitlab tools with a file allowlist', () => {
  it('serve only the chunk files', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => /\/diffs\?/.test(url) && new URL(url).searchParams.get('page') === '1'
      ? new Response(JSON.stringify([{ old_path: 'a.php', new_path: 'a.php', diff: 'x' }, { old_path: 'b.php', new_path: 'b.php', diff: 'y' }]), { status: 200, headers: { 'x-next-page': '' } })
      : new Response('[]', { status: 200 })))
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 })
    const tools: Array<{ name: string; execute: (a: any, e?: any) => Promise<any> }> = []
    await forge.mountAgentTools({ plugin: async (mod: any, cfg: any) => mod.apply({ tools: { register: (t: any) => tools.push(t) } }, cfg) } as any, { onlyPaths: ['b.php'] })
    expect((await tools.find((t) => t.name === 'gitlab_get_mr_diff')!.execute({}, {})).files.map((x: { path: string }) => x.path)).toEqual(['b.php'])
    await expect(tools.find((t) => t.name === 'gitlab_get_file_diff')!.execute({ path: 'a.php' })).rejects.toThrow(/another part of this review/)
  })
})

describe('ci fan-out settings', () => {
  it('reads thresholds, concurrency and the deep model pair from the job environment', async () => {
    const { parseCiEnvConfig, ciFanout } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', REVIEW_FANOUT_FILES: '40', REVIEW_DEEP_MODEL_PROVIDER: 'p', REVIEW_DEEP_MODEL: 'strong' })
    expect(ciFanout(cfg)).toEqual({ fanout: { files: 40, bytes: 150_000, concurrency: 3 }, deepModel: { provider: 'p', model: 'strong' } })
    expect(ciFanout(parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' }))).toEqual({})
    expect(() => parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', REVIEW_FANOUT_FILES: '0' })).toThrow(/REVIEW_FANOUT_FILES/)
  })
})

describe('gitlab client config through its schema', () => {
  it('keeps every file when no allowlist is given (schemastery defaults arrays to empty)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    const GitlabClient = await import('../src/host/forge/gitlab/gitlab-client.js')
    const cfg = GitlabClient.Config({ baseUrl: 'https://git.example.com', projectId: 1, mrIid: 2, token: 't', botUsername: 'bot',
      loadDiffs: async () => ({ diffs: [{ old_path: 'a.php', new_path: 'a.php', diff: 'x' }], skipped: [], truncated: false }) })
    const tools: Array<{ name: string; execute: (a: any, e?: any) => Promise<any> }> = []
    GitlabClient.apply({ tools: { register: (t: any) => tools.push(t) } } as any, cfg)
    expect((await tools.find((t) => t.name === 'gitlab_get_mr_diff')!.execute({}, {})).files.map((x: { path: string }) => x.path)).toEqual(['a.php'])
  })
})
