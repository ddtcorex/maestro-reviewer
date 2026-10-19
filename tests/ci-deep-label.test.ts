import { describe, expect, it, vi } from 'vitest'
import { encodeReviewMeta, reviewMarker, type ReviewMeta } from '../src/host/review-marker.js'

const BOT = 42
const meta = (headSha: string, mode: 'quick' | 'deep'): ReviewMeta => ({ v: 1, headSha, mode, models: [], findings: [], at: '2026-10-19T00:00:00.000Z' })
const review = (sha: string, mode: 'quick' | 'deep') => ({ id: 1, system: false, author: { id: BOT }, body: `## Review\n\n${reviewMarker(sha, mode === 'deep' ? 'ci-deep' : 'ci-quick')}\n${encodeReviewMeta(meta(sha, mode))}`, created_at: '2026-10-19T00:00:00Z' })

function gitlab(notes: unknown[]) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (u.pathname.endsWith('/user')) return new Response(JSON.stringify({ id: BOT }), { status: 200 })
    if (u.pathname.endsWith('/notes')) return new Response(JSON.stringify(notes), { status: 200, headers: { 'x-next-page': '' } })
    if (u.pathname.endsWith('/award_emoji')) return new Response('[]', { status: 200 })
    return new Response(JSON.stringify({ source_branch: 'feat/x', sha: 'cafe01', references: { full: 'g/p!2' } }), { status: 200 })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

async function gate(env: Record<string, string>, notes: unknown[], ok = true) {
  const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
  const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', MAESTRO_GITLAB_TOKEN: 'tok', SOURCE_PROJECT_ID: '1', MR_IID: '2', ...env })
  const ctx = { reviewRunner: vi.fn(async () => ({ ok, summary: 'done', failures: [], durationMs: 5 })) }
  const g = gitlab(notes)
  const result = await runCiTrigger(ctx as never, cfg, { fetcher: g.fetcher, writeFile: (async () => {}) as never, history: { lastCompletedReview: async () => undefined } })
  const labelPuts = g.calls.filter(c => c.method === 'PUT' && c.path.endsWith('/merge_requests/2'))
  return { result, ctx, labelPuts }
}

const DEEP = { REVIEW_MODE: 'deep', REVIEW_DEEP_REQUESTED: '1' }

describe('deep review on request, once per head SHA', () => {
  it('runs deep on a SHA that only has a quick review', async () => {
    const { ctx } = await gate(DEEP, [review('cafe01', 'quick')])
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
    expect((ctx.reviewRunner.mock.calls[0] as unknown[])[0]).toMatchObject({ mode: 'deep', headSha: 'cafe01' })
  })

  it('runs deep on a new head even without REVIEW_ON_PUSH (the label is the request)', async () => {
    const { ctx } = await gate(DEEP, [review('abc123', 'quick')])
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
  })

  it('skips when the bot already posted a deep review for this SHA, and clears the stale label', async () => {
    const { result, ctx, labelPuts } = await gate(DEEP, [review('cafe01', 'deep')])
    expect(ctx.reviewRunner).not.toHaveBeenCalled()
    expect(result.summary).toMatch(/deep review already completed at cafe01/)
    expect(labelPuts).toHaveLength(1)
  })

  it('does not count a deep marker without metadata', async () => {
    const markerOnly = { id: 1, system: false, author: { id: BOT }, body: reviewMarker('cafe01', 'ci-deep'), created_at: '2026-10-19T00:00:00Z' }
    const { ctx } = await gate(DEEP, [markerOnly])
    expect(ctx.reviewRunner).toHaveBeenCalledTimes(1)
  })

  it('removes the label once after a successful deep review', async () => {
    const { labelPuts } = await gate(DEEP, [])
    expect(labelPuts).toHaveLength(1)
    expect(labelPuts[0].body).toEqual({ remove_labels: 'maestro-review::deep' })
  })

  it('keeps the label when the deep review fails, so a retry works', async () => {
    const { labelPuts } = await gate(DEEP, [], false)
    expect(labelPuts).toHaveLength(0)
  })

  it('without a request, a quick review at the head SHA still skips as before', async () => {
    const { ctx, labelPuts } = await gate({}, [review('cafe01', 'quick')])
    expect(ctx.reviewRunner).not.toHaveBeenCalled()
    expect(labelPuts).toHaveLength(0)
  })
})
