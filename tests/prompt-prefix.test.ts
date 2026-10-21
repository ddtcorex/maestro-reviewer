import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReviewerScopePrompt, reviewerPromptParts } from '../src/host/orchestrator.js'

vi.mock('../src/host/ci-clone.js', () => ({
  cloneSourceRepo: vi.fn(async (opts: any) => opts.dir),
  defaultRun: vi.fn(async () => {}),
  redactCloneUrl: (u: string) => u,
}))
vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

const opts = (n: number) => ({
  scopeKind: 'full' as const, mode: 'quick', profileInstruction: 'Call maestro_load_review_profile with {"profile":"magento2"} before examining code. ',
  lint: { worktreePath: `/tmp/wt-${n}`, base: `base${n}sha` },
  incrementalBlock: `This MR was reviewed before (at head${n}sha). Changed files since last review: ${n}`,
})

describe('reviewer prompt prefix', () => {
  it('keeps every per-MR value out of the stable part, identical across merge requests', () => {
    const a = reviewerPromptParts(opts(1))
    const b = reviewerPromptParts(opts(2))
    expect(a.stable).toEqual(b.stable)
    const stable = a.stable.join('')
    for (const v of ['/tmp/wt-1', 'base1sha', 'head1sha', 'reviewed before']) expect(stable).not.toContain(v)
    expect(a.dynamic.join('')).toContain('base1sha')
    expect(a.dynamic.join('')).toContain('head1sha')
  })

  it('puts the stable part first and the per-MR part last in the prompt', () => {
    const prompt = buildReviewerScopePrompt(opts(1))
    const parts = reviewerPromptParts(opts(1))
    expect(prompt.startsWith(parts.stable.join(''))).toBe(true)
    expect(prompt.endsWith(`This MR was reviewed before (at head1sha). Changed files since last review: 1`)).toBe(true)
    expect(prompt.indexOf('LINT RULE')).toBeGreaterThan(prompt.indexOf('DEDUP RULE'))
  })
})

describe('ci clone worktree path', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))))
  afterEach(() => vi.unstubAllGlobals())

  it('is the same for every merge request, so the runtime context the model sees stays stable', async () => {
    const { defaultRun } = await import('../src/host/ci-clone.js')
    const { createReviewEngine, CI_WORKTREE_PATH } = await import('../src/host/engine.js')
    const worktrees: string[] = []
    const agents = { reviewer: vi.fn(async (w: string) => { worktrees.push(w); return { summary: 'ok', failures: [] } }), auditor: vi.fn() }
    const engine = createReviewEngine({} as any, agents as any)
    for (const [projectId, mrIid] of [[3, 4], [8, 9]]) {
      await engine.run({ projectPath: 'g/p', projectId, mrIid, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
        { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'clone', host: 'git.example.com' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000 })
    }
    expect(worktrees).toEqual([CI_WORKTREE_PATH, CI_WORKTREE_PATH])
    expect(vi.mocked(defaultRun).mock.calls.some((c) => (c[1] as string[]).includes(CI_WORKTREE_PATH))).toBe(true)
  })
})
