import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/host/config-store.js', () => ({ loadUserConfig: async () => ({}) }))
vi.mock('../src/host/ci-clone.js', () => ({
  cloneSourceRepo: vi.fn(async (opts: any) => opts.dir),
  defaultRun: vi.fn(async () => {}),
  redactCloneUrl: (u: string) => u,
}))
// runReview writes history to disk — stub the store so tests stay hermetic
// (existing tests in this file return before reaching it).
vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return {
    ...mod,
    recordReviewStart: vi.fn(async () => {}),
    recordReviewFinish: vi.fn(async () => {}),
    lastCompletedReview: vi.fn(async () => undefined),
  }
})

describe('orchestrator.apply — reviewRunner wiring', () => {
  it('registers the maestro/review-request event handler and provides reviewRunner', async () => {
    const { apply } = await import('../src/host/orchestrator.js')
    const onCalls: string[] = []
    const provideCalls: string[] = []
    const fakeCtx = {
      on: (event: string, _handler: unknown) => { onCalls.push(event) },
      provide: (name: string, _value: unknown) => { provideCalls.push(name) },
    }
    apply(fakeCtx as any, {
      projectMappings: [],
      gitlabBaseUrl: 'https://gitlab.example.com',
      botUsername: 'maestro-bot',
      agentTimeoutMs: 1000,
    })
    expect(onCalls).toContain('maestro/review-request')
    expect(provideCalls).toContain('reviewRunner')
  })

  it('runReview resolves { ok: true, failures: [] } without touching agents for an unmapped, non-mention trigger', async () => {
    const { apply } = await import('../src/host/orchestrator.js')
    let runReview: ((payload: any) => Promise<any>) | undefined
    const fakeCtx = {
      on: () => {},
      provide: (name: string, fn: any) => { if (name === 'reviewRunner') runReview = fn },
    }
    apply(fakeCtx as any, { projectMappings: [], gitlabBaseUrl: 'https://gitlab.example.com', botUsername: 'maestro-bot', agentTimeoutMs: 1000 })
    const result = await runReview!({
      projectPath: 'group/proj', projectId: 1, mrIid: 2, sourceBranch: 'feat/x',
      trigger: 'reviewer-assignment', mode: 'quick', scope: { kind: 'mr' },
    })
    expect(result).toEqual({ ok: true, failures: [], durationMs: expect.any(Number) })
  })

  it('runReview resolves { ok: false } with a failure message when no GitLab token is configured', async () => {    const { apply } = await import('../src/host/orchestrator.js')
    let runReview: ((payload: any) => Promise<any>) | undefined
    const fakeCtx = {
      on: () => {},
      provide: (name: string, fn: any) => { if (name === 'reviewRunner') runReview = fn },
    }
    apply(fakeCtx as any, { projectMappings: [], gitlabBaseUrl: 'https://gitlab.example.com', botUsername: 'maestro-bot', agentTimeoutMs: 1000 })
    const result = await runReview!({
      projectPath: 'group/proj', projectId: 1, mrIid: 2, sourceBranch: 'feat/x',
      trigger: 'mention', mode: 'quick', scope: { kind: 'mr' },
    })
    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/no GitLab token/)
  })
})

describe('CI deep review', () => {
  const CI_ENV = { SOURCE_PROJECT_ID: '1', MR_IID: '2', GITLAB_HOST: 'gitlab.example.com', MAESTRO_GITLAB_TOKEN: 't' }
  function setCiEnv() { for (const [k, v] of Object.entries(CI_ENV)) process.env[k] = v }
  function clearCiEnv() { for (const k of Object.keys(CI_ENV)) delete process.env[k] }

  it('withAuditorDegrade returns reviewer-only note when the auditor throws', async () => {
    const { withAuditorDegrade } = await import('../src/host/orchestrator.js')
    const wrapped = withAuditorDegrade(async () => { throw new Error('govard: binary not found') })
    await expect(wrapped('/tmp/x', {} as any)).resolves.toMatch(/reviewer-only/)
  })

  it('withAuditorDegrade passes auditor output through', async () => {
    const { withAuditorDegrade } = await import('../src/host/orchestrator.js')
    const wrapped = withAuditorDegrade(async () => 'audit says hi')
    await expect(wrapped('/tmp/x', {} as any)).resolves.toBe('audit says hi')
  })

  it('runReview stays diff-only for quick + generic profile (no clone)', async () => {
    const { apply } = await import('../src/host/orchestrator.js')
    const { cloneSourceRepo } = await import('../src/host/ci-clone.js')
    setCiEnv()
    try {
      vi.mocked(cloneSourceRepo).mockClear()
      let runReview: ((payload: any) => Promise<any>) | undefined
      apply({ on: () => {}, provide: (name: string, fn: any) => { if (name === 'reviewRunner') runReview = fn } } as any,
        { projectMappings: [], gitlabBaseUrl: 'https://gitlab.example.com', botUsername: 'b', agentTimeoutMs: 1000, gitlabToken: 't' })
      await runReview!({
        projectPath: 'group/proj', projectId: 1, mrIid: 2, sourceBranch: 'feat/x', headSha: 'abc123',
        trigger: 'mention', mode: 'quick', reviewProfile: 'generic', scope: { kind: 'mr' },
      }).catch(() => {})
      expect(cloneSourceRepo).not.toHaveBeenCalled()
    } finally { clearCiEnv() }
  }, 30000)
})

describe('resolveReviewModel — row-config reviewModel', () => {  it('uses the row selection when mapping and user config are absent (CI profile case)', async () => {
    const { resolveReviewModel } = await import('../src/host/orchestrator.js')
    expect(resolveReviewModel({}, undefined,
      { provider: 'fallback', model: 'fallback' },
      { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }),
    ).toEqual({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' })
  })

  it('prefers user config over the row selection', async () => {
    const { resolveReviewModel } = await import('../src/host/orchestrator.js')
    expect(resolveReviewModel({ reviewModel: { provider: 'u', model: 'um' } }, undefined,
      { provider: 'fallback', model: 'fallback' },
      { provider: 'row', model: 'rowm' }),
    ).toEqual({ provider: 'u', model: 'um' })
  })

  it('prefers mapping override over the row selection', async () => {
    const { resolveReviewModel } = await import('../src/host/orchestrator.js')
    expect(resolveReviewModel({}, { reviewModel: { provider: 'm', model: 'mm' } },
      { provider: 'fallback', model: 'fallback' },
      { provider: 'row', model: 'rowm' }),
    ).toEqual({ provider: 'm', model: 'mm' })
  })

  it('falls back to the host default when all three are absent', async () => {
    const { resolveReviewModel } = await import('../src/host/orchestrator.js')
    expect(resolveReviewModel({}, undefined,
      { provider: 'fallback', model: 'fallback' }, undefined),
    ).toEqual({ provider: 'fallback', model: 'fallback' })
  })
})

describe('Config — boot contract', () => {
  // Regression: a declared-but-optional object schema still descends in
  // schemastery, so the row reviewModel must stay undeclared (passthrough)
  // or every boot without REVIEW_MODEL_* fails. Caught by container E2E.
  it('validates without reviewModel (CI boots with no REVIEW_MODEL_*)', async () => {
    const { Config } = await import('../src/host/orchestrator.js')
    expect(() => Config({
      projectMappings: [], gitlabBaseUrl: 'https://gitlab.example.com',
      botUsername: 'maestro-bot', agentTimeoutMs: 1000,
    })).not.toThrow()
  })
})

describe('declineUnmappedDeepReview — dedup signal', () => {
  it('concurrent duplicate returns false (no double decline comment)', async () => {
    const { declineUnmappedDeepReview } = await import('../src/host/orchestrator.js')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let posts = 0
    const deps = {
      postComment: async () => { posts += 1; await gate },
      replyToDiscussion: async () => {},
      writeFailedReport: async () => {},
    }
    const payload = {
      projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b',
      mode: 'deep', scope: { kind: 'mr' }, trigger: 'mention',
    } as const
    const first = declineUnmappedDeepReview(payload as any, deps as any)
    const second = await declineUnmappedDeepReview(payload as any, deps as any)
    expect(second).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(posts).toBe(1)
  })
})
