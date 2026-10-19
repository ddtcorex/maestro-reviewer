import { describe, it, expect, vi } from 'vitest'
import { ciAccess, ciModel, parseCiEnvConfig, fetchMrSourceBranch, runCiTrigger } from '../src/host/providers/ci-trigger.js'

describe('parseCiEnvConfig', () => {
  it('parses required env vars and defaults mode/dryRun', () => {
    const cfg = parseCiEnvConfig({
      GITLAB_HOST: 'gitlab.example.com', MAESTRO_GITLAB_TOKEN: 'glpat-xxx',
      SOURCE_PROJECT_ID: '123', MR_IID: '456',
    })
    expect(cfg).toEqual({
      gitlabBaseUrl: 'https://gitlab.example.com', gitlabHost: 'gitlab.example.com', gitlabToken: 'glpat-xxx', botUsername: 'maestro-bot',
      sourceProjectId: 123, mrIid: 456, mode: 'quick', dryRun: false, rereviewOnPush: false, deepRequested: false, agentTimeoutMs: 1_200_000,
    })
  })

  it('throws on missing token', () => {
    expect(() => parseCiEnvConfig({ GITLAB_HOST: 'h', SOURCE_PROJECT_ID: '1', MR_IID: '2' })).toThrow()
  })

  it('parses REVIEW_MODE=deep and REVIEW_DRY_RUN=1', () => {
    const cfg = parseCiEnvConfig({
      GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2',
      REVIEW_MODE: 'deep', REVIEW_DRY_RUN: '1',
    })
    expect(cfg.mode).toBe('deep')
    expect(cfg.dryRun).toBe(true)
  })

  it('leaves reviewProfile undefined when REVIEW_PROFILE is absent (legacy diff-only)', () => {
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    expect(cfg.reviewProfile).toBeUndefined()
  })

  it('parses REVIEW_PROFILE=magento2', () => {
    const cfg = parseCiEnvConfig({
      GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2',
      REVIEW_PROFILE: 'magento2',
    })
    expect(cfg.reviewProfile).toBe('magento2')
  })

  it('parses REVIEW_ON_PUSH=1 into rereviewOnPush, default false', () => {
    const on = parseCiEnvConfig({
      GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2',
      REVIEW_ON_PUSH: '1',
    })
    expect(on.rereviewOnPush).toBe(true)
    const off = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    expect(off.rereviewOnPush).toBe(false)
  })

  it('throws on unsupported REVIEW_PROFILE', () => {
    expect(() => parseCiEnvConfig({
      GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2',
      REVIEW_PROFILE: 'drupal',
    })).toThrow(/unsupported REVIEW_PROFILE/)
  })
})

describe('fetchMrDetail', () => {
  it('returns sourceBranch, headSha and projectPath from references.full', async () => {
    const { fetchMrDetail } = await import('../src/host/providers/ci-trigger.js')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      source_branch: 'feat/x', sha: 'abc123', references: { full: 'g/sub/proj!2' },
    }), { status: 200 }))
    await expect(fetchMrDetail(
      parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' }),
      fetcher as unknown as typeof fetch,
    )).resolves.toEqual({ sourceBranch: 'feat/x', headSha: 'abc123', projectPath: 'g/sub/proj' })
  })

  it('falls back to project/<id> when references is absent', async () => {
    const { fetchMrDetail } = await import('../src/host/providers/ci-trigger.js')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
    await expect(fetchMrDetail(
      parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' }),
      fetcher as unknown as typeof fetch,
    )).resolves.toEqual({ sourceBranch: 'feat/x', headSha: 'abc123', projectPath: 'project/1' })
  })

  it('uses JOB-TOKEN header when GITLAB_TOKEN_KIND=job', async () => {
    process.env.GITLAB_TOKEN_KIND = 'job'
    try {
      const { fetchMrDetail } = await import('../src/host/providers/ci-trigger.js')
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
      await fetchMrDetail(
        parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' }),
        fetcher as unknown as typeof fetch,
      )
      expect(fetcher).toHaveBeenCalledWith('https://h/api/v4/projects/1/merge_requests/2', { headers: { 'JOB-TOKEN': 'tok' } })
    } finally {
      delete process.env.GITLAB_TOKEN_KIND
    }
  })
})

describe('runCiTrigger push-gate', () => {
  const mrFetcher = (sha: string) => vi.fn(async () => new Response(
    JSON.stringify({ source_branch: 'feat/x', sha }), { status: 200 }))
  const fakeWriteFile = (async () => {}) as unknown as typeof import('node:fs/promises').writeFile
  async function runGate(env: Record<string, string | undefined>, sha: string, prior: { headSha?: string } | undefined) {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2', ...env })
    const fakeCtx = { reviewEngine: { run: vi.fn(async () => ({ ok: true, summary: 'done', failures: [], durationMs: 5 })) } }
    const history = { lastCompletedReview: vi.fn(async () => prior) }
    const result = await runCiTrigger(fakeCtx as any, cfg, {
      fetcher: mrFetcher(sha) as unknown as typeof fetch, writeFile: fakeWriteFile, history,
    })
    return { result, ran: (fakeCtx.reviewEngine.run as ReturnType<typeof vi.fn>).mock.calls.length > 0 }
  }

  it('skips when the head SHA already has a completed review (flag on or off)', async () => {
    for (const env of [{}, { REVIEW_ON_PUSH: '1' }]) {
      const { result, ran } = await runGate(env, 'abc', { headSha: 'abc' })
      expect(ran).toBe(false)
      expect(result.ok).toBe(true)
      expect(result.summary).toMatch(/already reviewed/)
    }
  })

  it('skips a new SHA when REVIEW_ON_PUSH is off and a prior review exists', async () => {
    const { result, ran } = await runGate({}, 'def', { headSha: 'abc' })
    expect(ran).toBe(false)
    expect(result.summary).toMatch(/REVIEW_ON_PUSH/)
  })

  it('runs a new SHA when REVIEW_ON_PUSH=1 (incremental context comes from history)', async () => {
    const { result, ran } = await runGate({ REVIEW_ON_PUSH: '1' }, 'def', { headSha: 'abc' })
    expect(ran).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('runs when no prior review exists (MR opened)', async () => {
    const { ran } = await runGate({}, 'abc', undefined)
    expect(ran).toBe(true)
  })
})

describe('runCiTrigger coexistence yield', () => {
  const fakeWriteFile = (async () => {}) as unknown as typeof import('node:fs/promises').writeFile
  async function runYield(sha: string, notesBodies: string[], awards: Array<{ name: string }>) {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 42 }), { status: 200 })
      if (String(url).includes('/notes')) return new Response(JSON.stringify(notesBodies.map((body, i) => ({ id: i, author: { id: 42 }, body }))), { status: 200 })
      if (String(url).includes('/award_emoji')) return new Response(JSON.stringify(awards.map((a, i) => ({ id: i, user: { id: 42 }, ...a }))), { status: 200 })
      return new Response(JSON.stringify({ source_branch: 'feat/x', sha }), { status: 200 })
    })
    const fakeCtx = { reviewEngine: { run: vi.fn(async () => ({ ok: true, summary: 'done', failures: [], durationMs: 5 })) } }
    const history = { lastCompletedReview: vi.fn(async () => undefined) }
    const result = await runCiTrigger(fakeCtx as any, cfg, {
      fetcher: fetcher as unknown as typeof fetch, writeFile: fakeWriteFile, history,
    })
    return { result, ran: (fakeCtx.reviewEngine.run as ReturnType<typeof vi.fn>).mock.calls.length > 0 }
  }

  it('skips when another flow already completed this SHA', async () => {
    const { result, ran } = await runYield('abc123', ['x <!-- maestro-review sha=abc123 flow=webhook status=completed --> y'], [])
    expect(ran).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/already reviewed/)
  })

  it('skips when an eyes running marker is present', async () => {
    const { result, ran } = await runYield('abc123', [], [{ name: 'eyes' }])
    expect(ran).toBe(false)
    expect(result.summary).toMatch(/another review is running/)
  })

  it('runs when no marker and no eyes', async () => {
    const { ran } = await runYield('abc123', [], [])
    expect(ran).toBe(true)
  })

  it('threads headSha into the review request', async () => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/notes')) return new Response('[]', { status: 200 })
      if (String(url).includes('/award_emoji')) return new Response('[]', { status: 200 })
      return new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 })
    })
    const fakeCtx = { reviewEngine: { run: vi.fn(async () => ({ ok: true, summary: 'done', failures: [], durationMs: 5 })) } }
    await runCiTrigger(fakeCtx as any, cfg, {
      fetcher: fetcher as unknown as typeof fetch,
      writeFile: fakeWriteFile,
      history: { lastCompletedReview: vi.fn(async () => undefined) },
    })
    expect((fakeCtx.reviewEngine.run.mock.calls[0] as unknown[])[0]).toMatchObject({ headSha: 'abc123' })
  })
})

describe('fetchMrSourceBranch', () => {
  it('calls /merge_requests/:iid with PRIVATE-TOKEN and returns source_branch', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const branch = await fetchMrSourceBranch(cfg, fetcher as unknown as typeof fetch)
    expect(branch).toBe('feat/x')
    expect(fetcher).toHaveBeenCalledWith('https://h/api/v4/projects/1/merge_requests/2', { headers: { 'PRIVATE-TOKEN': 'tok' } })
  })

  it('throws on non-200', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 }))
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    await expect(fetchMrSourceBranch(cfg, fetcher as unknown as typeof fetch)).rejects.toThrow(/GitLab API error 404/)
  })
})

describe('runCiTrigger', () => {
  it('builds a ReviewRequest with trigger "mention" and calls ctx.reviewEngine.run, then writes report files', async () => {
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      source_branch: 'feat/x', sha: 'abc123', references: { full: 'g/sub/proj!2' },
    }), { status: 200 }))
    let capturedRequest: unknown
    const fakeCtx = { reviewEngine: { run: vi.fn(async (req: unknown) => { capturedRequest = req; return { ok: true, summary: 'done', failures: [], durationMs: 5 } }) } }
    const writes: Array<[string, string]> = []
    const fakeWriteFile = (async (path: string, data: string) => { writes.push([path, data]) }) as unknown as typeof import('node:fs/promises').writeFile
    const result = await runCiTrigger(fakeCtx as any, cfg, { fetcher: fetcher as unknown as typeof fetch, writeFile: fakeWriteFile })
    expect(capturedRequest).toEqual({
      projectPath: 'g/sub/proj', projectId: 1, mrIid: 2, sourceBranch: 'feat/x', headSha: 'abc123',
      trigger: 'mention', mode: 'quick', scope: { kind: 'mr' },
    })
    expect(result.ok).toBe(true)
    expect(writes.map(w => w[0])).toEqual(['review-report.json', 'review-report.md'])
    expect(writes[0][1]).toContain('"summary": "done"')
  })

  it('prefixes report paths with REVIEW_REPORT_DIR when set (entrypoint cds away)', async () => {
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
    const fakeCtx = { reviewEngine: { run: vi.fn(async () => ({ ok: true, summary: 'done', failures: [], durationMs: 5 })) } }
    const writes: Array<[string, string]> = []
    const fakeWriteFile = (async (path: string, data: string) => { writes.push([path, data]) }) as unknown as typeof import('node:fs/promises').writeFile
    process.env.REVIEW_REPORT_DIR = '/out'
    try {
      await runCiTrigger(fakeCtx as any, cfg, { fetcher: fetcher as unknown as typeof fetch, writeFile: fakeWriteFile })
    } finally {
      delete process.env.REVIEW_REPORT_DIR
    }
    expect(writes.map(w => w[0])).toEqual(['/out/review-report.json', '/out/review-report.md'])
  })

  it('carries REVIEW_PROFILE into the ReviewRequest', async () => {
    const cfg = parseCiEnvConfig({
      GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2',
      REVIEW_PROFILE: 'magento2',
    })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
    let capturedRequest: unknown
    const fakeCtx = { reviewEngine: { run: vi.fn(async (req: unknown) => { capturedRequest = req; return { ok: true, summary: 'done', failures: [], durationMs: 5 } }) } }
    const fakeWriteFile = (async () => {}) as unknown as typeof import('node:fs/promises').writeFile
    await runCiTrigger(fakeCtx as any, cfg, { fetcher: fetcher as unknown as typeof fetch, writeFile: fakeWriteFile })
    expect(capturedRequest).toEqual({
      projectPath: 'project/1', projectId: 1, mrIid: 2, sourceBranch: 'feat/x', headSha: 'abc123',
      trigger: 'mention', mode: 'quick', scope: { kind: 'mr' }, reviewProfile: 'magento2',
    })
  })
})

describe('ci engine options', () => {
  const env = (o: Record<string, string> = {}) => parseCiEnvConfig({ GITLAB_HOST: 'git.example.com', MAESTRO_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', ...o })

  it('quick with no or the generic profile reads the diff only', () => {
    expect(ciAccess(env())).toEqual({ kind: 'diff' })
    expect(ciAccess(env({ REVIEW_PROFILE: 'generic' }))).toEqual({ kind: 'diff' })
  })

  it('quick with a framework profile and every deep review clone from the configured host', () => {
    expect(ciAccess(env({ REVIEW_PROFILE: 'magento2' }))).toEqual({ kind: 'clone', host: 'git.example.com' })
    expect(ciAccess(env({ REVIEW_MODE: 'deep' }))).toEqual({ kind: 'clone', host: 'git.example.com' })
    expect(ciAccess(env({ REVIEW_DEEP_REQUESTED: '1', REVIEW_PROFILE: 'generic' }))).toEqual({ kind: 'clone', host: 'git.example.com' })
  })

  it('reads the bot username and the pinned model from the environment', () => {
    const cfg = env({ REVIEW_BOT_USERNAME: 'review-bot', REVIEW_MODEL_PROVIDER: 'custom-openai', REVIEW_MODEL: 'm1' })
    expect(cfg.botUsername).toBe('review-bot')
    expect(ciModel({} as any, cfg)).toEqual({ provider: 'custom-openai', model: 'm1' })
  })

  it('falls back to the host default model without a pin', () => {
    const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }) } }
    expect(ciModel(ctx as any, env())).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('runs the engine with the access, gitlab identity and timeout from the config', async () => {
    const cfg = env({ REVIEW_PROFILE: 'magento2', REVIEW_BOT_USERNAME: 'review-bot', REVIEW_MODEL_PROVIDER: 'p', REVIEW_MODEL: 'm' })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
    const run = vi.fn(async () => ({ ok: true, summary: 'done', failures: [], durationMs: 5 }))
    await runCiTrigger({ reviewEngine: { run } } as any, cfg, { fetcher: fetcher as unknown as typeof fetch, writeFile: (async () => {}) as any })
    expect((run.mock.calls[0] as unknown[])[1]).toEqual({
      gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'review-bot' },
      access: { kind: 'clone', host: 'git.example.com' },
      reviewProfile: 'magento2',
      model: { provider: 'p', model: 'm' },
      agentTimeoutMs: 1_200_000,
    })
  })
})
