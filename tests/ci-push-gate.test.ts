import { describe, expect, it, vi } from 'vitest'
import { latestCompletedReview } from '../src/host/ci-coexist.js'
import { encodeReviewMeta, reviewMarker, type ReviewMeta } from '../src/host/review-marker.js'

const BOT = 42
const meta = (headSha: string): ReviewMeta => ({ v: 1, headSha, mode: 'quick', models: [], findings: [], at: '2026-10-19T00:00:00.000Z' })
const note = (id: number, authorId: number, body: string) => ({ id, system: false, author: { id: authorId, username: authorId === BOT ? 'bot' : 'dev' }, body, created_at: '2026-10-19T00:00:00Z' })
const reviewBody = (sha: string) => `## Review\n\n${reviewMarker(sha, 'ci-quick')}\n${encodeReviewMeta(meta(sha))}`

/** GitLab double: /user, paginated MR notes (newest first), MR detail. */
function gitlab(pages: Array<Array<ReturnType<typeof note>>>, opts: { userStatus?: number; mrSha?: string; awards?: Array<{ name: string; user: { id: number } }> } = {}) {
  const calls: string[] = []
  const fetcher = vi.fn(async (url: string) => {
    const u = new URL(url)
    calls.push(u.pathname + u.search)
    if (u.pathname.endsWith('/user')) {
      return opts.userStatus && opts.userStatus !== 200 ? new Response('no', { status: opts.userStatus }) : new Response(JSON.stringify({ id: BOT, username: 'bot' }), { status: 200 })
    }
    if (u.pathname.endsWith('/award_emoji')) return new Response(JSON.stringify(opts.awards ?? []), { status: 200 })
    if (u.pathname.endsWith('/notes')) {
      const page = Number(u.searchParams.get('page') ?? '1')
      const next = page < pages.length ? String(page + 1) : ''
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200, headers: { 'x-next-page': next } })
    }
    return new Response(JSON.stringify({ source_branch: 'feat/x', sha: opts.mrSha ?? 'cafe01', references: { full: 'g/p!2' } }), { status: 200 })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}
const opts = { baseUrl: 'https://h', token: 't', projectId: 1, mrIid: 2 }

describe('latestCompletedReview', () => {
  it('finds the newest bot review on page 3', async () => {
    const filler = (n: number) => Array.from({ length: 3 }, (_, i) => note(n * 10 + i, 7, 'chatter'))
    const { fetcher, calls } = gitlab([filler(1), filler(2), [note(31, BOT, reviewBody('abc123'))]])
    expect((await latestCompletedReview(fetcher, opts))?.headSha).toBe('abc123')
    expect(calls.filter(c => c.includes('/notes')).every(c => /sort=desc/.test(c) && /per_page=100/.test(c))).toBe(true)
  })

  it('ignores metadata posted by anyone but the bot user (a spoof cannot suppress a review)', async () => {
    const { fetcher } = gitlab([[note(2, 7, reviewBody('beef00')), note(1, BOT, reviewBody('abc123'))]])
    expect((await latestCompletedReview(fetcher, opts))?.headSha).toBe('abc123')
  })

  it('ignores a bot comment without metadata (no pre-0.14 compatibility)', async () => {
    const { fetcher } = gitlab([[note(1, BOT, `## Review\n\n${reviewMarker('d00d00', 'ci-deep')}`)]])
    expect(await latestCompletedReview(fetcher, opts)).toBeUndefined()
  })

  it('returns undefined when the MR has no bot review', async () => {
    const { fetcher } = gitlab([[note(1, 7, 'hello')]])
    expect(await latestCompletedReview(fetcher, opts)).toBeUndefined()
  })

  it('throws when the bot identity cannot be read, so the caller can fall back', async () => {
    const { fetcher } = gitlab([[]], { userStatus: 401 })
    await expect(latestCompletedReview(fetcher, opts)).rejects.toThrow(/bot user/)
  })
})

describe('runCiTrigger push-gate from GitLab state', () => {
  const fakeWriteFile = (async () => {}) as unknown as typeof import('node:fs/promises').writeFile
  async function gate(env: Record<string, string>, pages: Array<Array<ReturnType<typeof note>>>, g: Parameters<typeof gitlab>[1] = {}, cache?: { headSha?: string }) {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2', ...env })
    const ctx = { reviewRunner: vi.fn(async () => ({ ok: true, summary: 'done', failures: [], durationMs: 5 })) }
    const history = { lastCompletedReview: vi.fn(async () => cache) }
    const result = await runCiTrigger(ctx as never, cfg, { fetcher: gitlab(pages, g).fetcher, writeFile: fakeWriteFile, history })
    return { result, ctx, history }
  }

  it('skips the head SHA GitLab already shows as reviewed, without consulting the runner cache', async () => {
    const { result, ctx, history } = await gate({}, [[note(1, BOT, reviewBody('cafe01'))]], { mrSha: 'cafe01' })
    expect(result.summary).toMatch(/already reviewed at cafe01/)
    expect(ctx.reviewRunner).not.toHaveBeenCalled()
    expect(history.lastCompletedReview).not.toHaveBeenCalled()
  })

  it('reviews a new head with REVIEW_ON_PUSH=1 and hands the prior head over for the incremental block', async () => {
    const { ctx } = await gate({ REVIEW_ON_PUSH: '1' }, [[note(1, BOT, reviewBody('abc123'))]], { mrSha: 'cafe01' })
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
    expect((ctx.reviewRunner.mock.calls[0] as unknown[])[0]).toMatchObject({ headSha: 'cafe01', priorHeadSha: 'abc123' })
  })

  it('reviews when GitLab shows no prior review even if the runner cache claims one', async () => {
    const { ctx } = await gate({}, [[note(1, 7, 'hi')]], { mrSha: 'cafe01' }, { headSha: 'cafe01' })
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
  })

  it('falls back to the runner cache only when the GitLab state cannot be read', async () => {
    const { result, history } = await gate({}, [[]], { userStatus: 500, mrSha: 'cafe01' }, { headSha: 'cafe01' })
    expect(history.lastCompletedReview).toHaveBeenCalledTimes(1)
    expect(result.summary).toMatch(/already reviewed at cafe01/)
  })

  it('fails open toward reviewing when both GitLab and the cache are empty', async () => {
    const { ctx } = await gate({}, [[]], { userStatus: 500, mrSha: 'cafe01' }, undefined)
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
  })

  it('skips a new head without REVIEW_ON_PUSH once GitLab shows a bot review (the 0.14 default)', async () => {
    const { result, ctx } = await gate({}, [[note(1, BOT, reviewBody('abc123'))]], { mrSha: 'cafe01' })
    expect(result.summary).toMatch(/REVIEW_ON_PUSH is not set/)
    expect(ctx.reviewRunner).not.toHaveBeenCalled()
  })

  it('reviews when only a human pasted a completed marker for the head SHA', async () => {
    const spoof = `<!-- maestro-review sha=cafe01 flow=ci-quick status=completed -->`
    const { ctx } = await gate({}, [[note(1, 7, spoof)]], { mrSha: 'cafe01' })
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
  })

  it('reviews when a human reacted with eyes', async () => {
    const { ctx } = await gate({}, [[note(1, 7, 'lgtm')]], { mrSha: 'cafe01', awards: [{ name: 'eyes', user: { id: 7 } }] })
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
  })

  it('yields to the bot user\'s own eyes marker', async () => {
    const { result, ctx } = await gate({}, [[]], { mrSha: 'cafe01', awards: [{ name: 'eyes', user: { id: BOT } }] })
    expect(result.summary).toMatch(/another review is running/)
    expect(ctx.reviewRunner).not.toHaveBeenCalled()
  })
})
