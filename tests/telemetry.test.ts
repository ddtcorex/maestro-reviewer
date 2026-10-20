import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStageTimer, sumUsage, usageFromSession } from '../src/host/telemetry.js'
import { parseReviewMeta } from '../src/host/review-marker.js'

vi.mock('../src/host/ci-clone.js', () => ({
  cloneSourceRepo: vi.fn(async (opts: any) => opts.dir),
  defaultRun: vi.fn(async () => {}),
  redactCloneUrl: (u: string) => u,
}))
vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

describe('createStageTimer', () => {
  it('attributes the time since the previous mark to the named stage and accumulates repeats', () => {
    let t = 1000
    const timer = createStageTimer(() => t)
    t = 1250; timer.mark('fetch')
    t = 2250; timer.mark('clone')
    t = 2300; timer.mark('fetch')
    expect(timer.toJSON()).toEqual({ fetch: 300, clone: 1000 })
  })

  it('subtracts excluded time from a stage and adds explicit durations', () => {
    let t = 0
    const timer = createStageTimer(() => t)
    t = 5000; timer.mark('agent', 1200)
    timer.add('post', 1200)
    timer.add('boot', 800)
    expect(timer.toJSON()).toEqual({ agent: 3800, post: 1200, boot: 800 })
  })
})

const message = (usage?: Record<string, number>) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: {}, stream: [], ...(usage === undefined ? {} : { usage }) } })

describe('usageFromSession', () => {
  it('sums the usage of every assistant message of the session', () => {
    const session = { ownEvents: () => [
      { type: 'user/message', data: {} },
      message({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 }),
      message({ inputTokens: 1500, outputTokens: 40 }),
    ] }
    expect(usageFromSession(session)).toEqual({ input: 2700, output: 120, cached: 1000 })
  })

  it('answers null when the session reports no usage at all', () => {
    expect(usageFromSession({})).toBeNull()
    expect(usageFromSession(undefined)).toBeNull()
    expect(usageFromSession({ ownEvents: () => [message()] })).toBeNull()
  })
})

describe('sumUsage', () => {
  it('adds the known usages and ignores the null ones', () => {
    expect(sumUsage([{ input: 1, output: 2, cached: 3 }, null, { input: 10, output: 20, cached: 0 }])).toEqual({ input: 11, output: 22, cached: 3 })
    expect(sumUsage([null, null])).toBeNull()
  })
})

describe('engine telemetry', () => {
  const payload = { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'feat/x', headSha: 'abc123', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any
  const gitlab = { baseUrl: 'https://gitlab.example.com', token: 't', botUsername: 'bot' }
  let noteBodies: string[]
  beforeEach(() => {
    noteBodies = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'POST' && /\/notes$/.test(url)) noteBodies.push(JSON.parse(String(init.body)).body)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  const usingAgents = (reviewerUsage: { input: number; output: number; cached: number } | null) => ({
    reviewer: vi.fn(async (_w: unknown, _p: unknown, run: any) => {
      run.onUsage('reviewer', 'm', reviewerUsage)
      return { summary: '0 new inline comment(s), 0 thread(s) updated.', failures: [], findings: [], models: ['m'] }
    }),
    auditor: vi.fn(),
  })

  it('returns stage timings and per agent usage, and sums the usage into the review metadata', async () => {
    const { createReviewEngine } = await import('../src/host/engine.js')
    const engine = createReviewEngine({} as any, usingAgents({ input: 900, output: 100, cached: 400 }) as any)
    const r = await engine.run(payload, { gitlab, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000 })
    expect(r.ok).toBe(true)
    expect(Object.keys(r.stages ?? {}).sort()).toEqual(['agent', 'fetch', 'post'])
    expect(r.usage).toEqual([{ agent: 'reviewer', model: 'm', usage: { input: 900, output: 100, cached: 400 } }])
    expect(parseReviewMeta(noteBodies[0])?.usage).toEqual({ input: 900, output: 100, cached: 400 })
  })

  it('keeps the timings and reports usage null when the session exposes none', async () => {
    const { createReviewEngine } = await import('../src/host/engine.js')
    const engine = createReviewEngine({} as any, usingAgents(null) as any)
    const r = await engine.run(payload, { gitlab, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000 })
    expect(r.usage).toEqual([{ agent: 'reviewer', model: 'm', usage: null }])
    expect(r.stages?.agent).toBeGreaterThanOrEqual(0)
    expect(parseReviewMeta(noteBodies[0])?.usage).toBeUndefined()
  })
})

describe('ci report', () => {
  it('writes the boot stage and the engine telemetry into review-report.json', async () => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const fetcher = vi.fn(async (url: string) => url.endsWith('/user')
      ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
      : url.includes('/notes') || url.includes('/award_emoji')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'abc123' }), { status: 200 }))
    const engineResult = { ok: true, summary: 'done', failures: [], durationMs: 5, stages: { fetch: 10, agent: 20, post: 3 }, usage: [{ agent: 'reviewer', model: 'm', usage: { input: 1, output: 2, cached: 0 } }] }
    const fakeCtx = { reviewEngine: { run: vi.fn(async () => engineResult) } }
    const writes: Array<[string, string]> = []
    const writeFile = (async (path: string, data: string) => { writes.push([path, data]) }) as unknown as typeof import('node:fs/promises').writeFile
    await runCiTrigger(fakeCtx as any, cfg, { fetcher: fetcher as unknown as typeof fetch, writeFile })
    const report = JSON.parse(writes[0][1])
    expect(report.stages.boot).toBeGreaterThan(0)
    expect(report.stages.fetch).toBeGreaterThanOrEqual(10)
    expect(report.stages.agent).toBe(20)
    expect(report.usage).toEqual(engineResult.usage)
  })
})
