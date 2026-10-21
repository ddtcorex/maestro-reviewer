import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIncrementalBlock, planIncremental } from '../src/host/incremental.js'
import { parseReviewMeta } from '../src/host/review-marker.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

const diff = (p: string, o: Record<string, unknown> = {}) => ({ old_path: p, new_path: p, diff: '@@ -1 +1 @@\n-a\n+b\n', ...o })
const compare = { commits: [{ short_id: 'c1', title: 'fix' }], diffs: [diff('app/A.php'), diff('composer.lock')] }

describe('planIncremental', () => {
  it('reviews only the interdiff when the base is unchanged and the prior head is reachable', () => {
    expect(planIncremental({ headSha: 'old', baseSha: 'b1' }, { headSha: 'new', baseSha: 'b1' }, compare))
      .toEqual({ kind: 'interdiff', files: compare.diffs })
  })

  it('falls back to a full review, naming why', () => {
    expect(planIncremental({ headSha: 'old', baseSha: 'b1' }, { headSha: 'new', baseSha: 'b2' }, compare)).toEqual({ kind: 'full', reason: 'base changed' })
    expect(planIncremental({ headSha: 'old', baseSha: 'b1' }, { headSha: 'new', baseSha: 'b1' }, undefined)).toEqual({ kind: 'full', reason: 'prior head unreachable' })
    expect(planIncremental({ headSha: 'old' }, { headSha: 'new', baseSha: 'b1' }, compare)).toEqual({ kind: 'full', reason: 'prior base unknown' })
    expect(planIncremental({ headSha: 'old', baseSha: 'b1' }, { headSha: 'new' }, compare)).toEqual({ kind: 'full', reason: 'prior base unknown' })
    const collapsed = { ...compare, diffs: [diff('app/A.php'), { old_path: 'big.php', new_path: 'big.php', too_large: true }] }
    expect(planIncremental({ headSha: 'old', baseSha: 'b1' }, { headSha: 'new', baseSha: 'b1' }, collapsed as any)).toEqual({ kind: 'full', reason: 'interdiff too large' })
  })
})

describe('buildIncrementalBlock in interdiff mode', () => {
  it('tells the reviewer the diff tools now show only the changes since the last review', () => {
    const block = buildIncrementalBlock(compare, 'oldsha1111', 'newsha2222', { interdiff: true })
    expect(block).toContain('only what changed since then')
    expect(block).toContain('Changed files since last review: 2')
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('gitlab forge restricted to an interdiff', () => {
  it('serves the interdiff, filtered by the ignore globs, without reading the MR diff', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 })
    forge.restrictToInterdiff(compare.diffs)
    expect(await forge.reviewScope()).toEqual({ files: 1, skipped: ['composer.lock'] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

function engineForge(base: string) {
  const restricted: unknown[] = []
  const notes: string[] = []
  const forge = {
    mrHeadSha: async () => 'abc1', mrBaseSha: async () => base,
    compare: async () => compare,
    reviewScope: async () => ({ files: 1, skipped: [] }),
    restrictToInterdiff: (files: unknown[]) => { restricted.push(files) },
    postNote: async (b: string) => { notes.push(b) }, replyToDiscussion: async () => {}, postFindings: async () => {},
    signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
  }
  return { forge, restricted, notes }
}

async function runEngine(base: string, priorBaseSha: string) {
  const { createReviewEngine } = await import('../src/host/engine.js')
  const blocks: Array<string | undefined> = []
  const agents = { reviewer: vi.fn(async (_w: unknown, _p: unknown, _r: unknown, _prof: unknown, block?: string) => { blocks.push(block); return { summary: 'ok', failures: [] } }), auditor: vi.fn() }
  const f = engineForge(base)
  await createReviewEngine({} as any, agents as any).run(
    { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc1', priorHeadSha: 'abc0', priorBaseSha, trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
    { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: f.forge as any },
  )
  return { ...f, blocks }
}

describe('engine incremental planning', () => {
  it('restricts the agents to the interdiff and records the base in the metadata', async () => {
    const { restricted, blocks, notes } = await runEngine('b1', 'b1')
    expect(restricted).toEqual([compare.diffs])
    expect(blocks[0]).toContain('only what changed since then')
    expect(parseReviewMeta(notes[0])?.baseSha).toBe('b1')
  })

  it('runs a full review without the incremental block after a rebase', async () => {
    const { restricted, blocks, notes } = await runEngine('b2', 'b1')
    expect(restricted).toEqual([])
    expect(blocks[0]).toBeUndefined()
    expect(parseReviewMeta(notes[0])?.baseSha).toBe('b2')
  })
})

describe('ci prior review', () => {
  it('hands the prior head and base from the review metadata to the engine', async () => {
    const { encodeReviewMeta } = await import('../src/host/review-marker.js')
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2', REVIEW_ON_PUSH: '1' })
    const meta = encodeReviewMeta({ v: 1, headSha: 'aaa', baseSha: 'bbb', mode: 'quick', models: [], findings: [], at: '2026-10-21T00:00:00Z' })
    const fetcher = vi.fn(async (url: string) => url.endsWith('/user') ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
      : url.includes('/notes') ? new Response(JSON.stringify([{ author: { id: 7 }, body: meta }]), { status: 200 })
        : url.includes('/award_emoji') ? new Response('[]', { status: 200 })
          : new Response(JSON.stringify({ source_branch: 'b', sha: 'ccc' }), { status: 200 }))
    const run = vi.fn(async () => ({ ok: true, summary: 'x', failures: [], durationMs: 1 }))
    await runCiTrigger({ reviewEngine: { run } } as any, cfg, { fetcher: fetcher as any, writeFile: (async () => {}) as any })
    expect((run.mock.calls[0] as any[])[0]).toMatchObject({ priorHeadSha: 'aaa', priorBaseSha: 'bbb' })
  })
})
