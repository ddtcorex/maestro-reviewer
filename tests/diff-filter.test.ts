import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IGNORE_GLOBS, filterDiffs, resolveIgnoreGlobs } from '../src/host/diff-filter.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

const d = (path: string, o: Record<string, unknown> = {}) => ({ old_path: path, new_path: path, diff: '@@ -1 +1 @@\n-a\n+b\n', ...o })

describe('filterDiffs', () => {
  it('filters a sample path for every default glob', () => {
    const samples = [
      'package-lock.json', 'web/pnpm-lock.yaml', 'theme/yarn.lock', 'composer.lock',
      'web/js/app.min.js', 'web/css/app.min.css', 'web/js/app.js.map', 'src/generated/Proxy.php',
      'pub/static/frontend/x.js', 'var/cache/x', 'tests/__snapshots__/a.snap', 'app/code/X/Y/i18n/fr_FR.csv',
    ]
    const { kept, skipped } = filterDiffs(samples.map((p) => d(p)), DEFAULT_IGNORE_GLOBS)
    expect(kept).toEqual([])
    expect(skipped).toEqual(samples)
    expect(DEFAULT_IGNORE_GLOBS).toHaveLength(12)
  })

  it('keeps source files', () => {
    const { kept, skipped } = filterDiffs([d('app/code/X/Model/A.php'), d('app/design/frontend/X/web/js/app.js')], DEFAULT_IGNORE_GLOBS)
    expect(kept.map((x) => x.new_path)).toEqual(['app/code/X/Model/A.php', 'app/design/frontend/X/web/js/app.js'])
    expect(skipped).toEqual([])
  })

  it('matches a deleted file on its old path and a moved file on its new path', () => {
    const { kept, skipped } = filterDiffs([
      d('var/log/old.log', { new_path: 'var/log/old.log', deleted_file: true }),
      { old_path: 'src/generated/A.php', new_path: 'app/code/X/A.php', diff: '' },
    ], DEFAULT_IGNORE_GLOBS)
    expect(skipped).toEqual(['var/log/old.log'])
    expect(kept.map((x) => x.new_path)).toEqual(['app/code/X/A.php'])
  })
})

describe('resolveIgnoreGlobs', () => {
  it('appends file globs, then REVIEW_IGNORE_GLOBS, to the defaults', () => {
    expect(resolveIgnoreGlobs({ REVIEW_IGNORE_GLOBS: ' docs/**, ,*.svg ' }, ['node/**'])).toEqual([...DEFAULT_IGNORE_GLOBS, 'node/**', 'docs/**', '*.svg'])
    expect(resolveIgnoreGlobs({})).toEqual([...DEFAULT_IGNORE_GLOBS])
  })
})

afterEach(() => { vi.unstubAllGlobals() })

const mrJson = (url: string) => {
  if (/\/diffs\?/.test(url)) {
    const page = Number(new URL(url).searchParams.get('page'))
    const body = page === 1 ? [d('composer.lock'), d('app/code/X/A.php'), d('pub/static/x.js')] : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'x-next-page': page === 1 ? '2' : '' } })
  }
  return new Response('{}', { status: 200 })
}

describe('gitlab forge with ignore globs', () => {
  it('reports the review scope and serves only kept files to the agent tools, fetching the diff once', async () => {
    const fetchSpy = vi.fn(async (url: string) => mrJson(url))
    vi.stubGlobal('fetch', fetchSpy)
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 }, { ignoreGlobs: DEFAULT_IGNORE_GLOBS })
    expect(await forge.reviewScope()).toEqual({ files: [{ path: 'app/code/X/A.php', bytes: 18 }], skipped: ['composer.lock', 'pub/static/x.js'] })
    const tools: Array<{ name: string; execute: (args: any, exec?: any) => Promise<any> }> = []
    await forge.mountAgentTools({ plugin: async (mod: any, cfg: any) => mod.apply({ tools: { register: (t: any) => tools.push(t) } }, cfg) } as any, {})
    const fileDiff = tools.find((t) => t.name === 'gitlab_get_file_diff')!
    const mrDiff = tools.find((t) => t.name === 'gitlab_get_mr_diff')!
    expect((await mrDiff.execute({}, {})).files.map((f: { path: string }) => f.path)).toEqual(['app/code/X/A.php'])
    await expect(fileDiff.execute({ path: 'composer.lock' })).rejects.toThrow(/filtered from this review/)
    expect(fetchSpy.mock.calls.filter(([u]) => /\/diffs\?/.test(String(u)))).toHaveLength(2)
  })
})

describe('engine with an all filtered merge request', () => {
  it('posts one nothing reviewable comment with the marker and never creates an agent', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') bodies.push(JSON.parse(String(init.body)).body)
      return new Response('{}', { status: 200 })
    }))
    const calls: string[] = []
    const forge = {
      mrHeadSha: async () => 'abc123', mrBaseSha: async () => 'base', compare: async () => undefined,
      reviewScope: async () => ({ files: [], skipped: ['composer.lock', 'pub/static/x.js'] }),
      postNote: async (body: string) => { bodies.push(body) }, replyToDiscussion: async () => {}, postFindings: async () => {},
      signals: () => ({ start: async () => { calls.push('start') }, finish: async (s: string) => { calls.push(`finish ${s}`) } }),
      mountAgentTools: async () => {},
    }
    const agents = { reviewer: vi.fn(), auditor: vi.fn() }
    const { createReviewEngine } = await import('../src/host/engine.js')
    const r = await createReviewEngine({} as any, agents as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc123', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any },
    )
    expect(r.ok).toBe(true)
    expect(agents.reviewer).not.toHaveBeenCalled()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('Nothing reviewable')
    expect(bodies[0]).toContain('`composer.lock`')
    expect(bodies[0]).toContain('<!-- maestro-review sha=abc123')
    expect(calls).toEqual(['start', 'finish completed'])
  })
})

describe('ci ignore globs', () => {
  it('passes the defaults plus REVIEW_IGNORE_GLOBS to the engine', async () => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2', REVIEW_IGNORE_GLOBS: 'docs/**' })
    expect(cfg.ignoreGlobs).toEqual([...DEFAULT_IGNORE_GLOBS, 'docs/**'])
    const fetcher = vi.fn(async (url: string) => url.endsWith('/user') ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
      : /notes|award_emoji/.test(url) ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ source_branch: 'b', sha: 'abc' }), { status: 200 }))
    const run = vi.fn(async () => ({ ok: true, summary: 'x', failures: [], durationMs: 1 }))
    await runCiTrigger({ reviewEngine: { run } } as any, cfg, { fetcher: fetcher as any, writeFile: (async () => {}) as any })
    expect((run.mock.calls[0] as any[])[1].ignoreGlobs).toEqual([...DEFAULT_IGNORE_GLOBS, 'docs/**'])
  })
})
