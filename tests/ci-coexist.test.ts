import { describe, it, expect, vi } from 'vitest'
import { hasCompletedReviewForSha, hasRunningEyes } from '../src/host/ci-coexist.js'

const BOT = 42
const notes = (items: Array<[number, string]>) => vi.fn(async () => new Response(JSON.stringify(items.map(([author, body], i) => ({ id: i, author: { id: author }, body }))), { status: 200 }))
const awards = (items: Array<[number, string]>) => vi.fn(async () => new Response(JSON.stringify(items.map(([user, name], i) => ({ id: i, name, user: { id: user } }))), { status: 200 }))
const f = (x: unknown) => x as unknown as typeof fetch

describe('ci-coexist', () => {
  it('finds a completed marker for the same SHA', async () => {
    const n = notes([[BOT, 'x <!-- maestro-review sha=abc123 flow=webhook status=completed --> y']])
    await expect(hasCompletedReviewForSha(f(n), 'https://h', 't', 1, 2, 'abc123', BOT)).resolves.toBe(true)
    expect(n).toHaveBeenCalledWith('https://h/api/v4/projects/1/merge_requests/2/notes?per_page=100&sort=desc&order_by=created_at', expect.anything())
  })
  it('ignores markers for other SHAs', async () => {
    const n = notes([[BOT, '<!-- maestro-review sha=deadbee flow=webhook status=completed -->']])
    await expect(hasCompletedReviewForSha(f(n), 'https://h', 't', 1, 2, 'abc123', BOT)).resolves.toBe(false)
  })
  it('ignores a completed marker pasted by anyone but the bot user', async () => {
    const n = notes([[7, '<!-- maestro-review sha=abc123 flow=ci-quick status=completed -->']])
    await expect(hasCompletedReviewForSha(f(n), 'https://h', 't', 1, 2, 'abc123', BOT)).resolves.toBe(false)
  })
  it('returns false without a bot identity (fail open toward running)', async () => {
    const n = notes([[BOT, '<!-- maestro-review sha=abc123 flow=ci-quick status=completed -->']])
    await expect(hasCompletedReviewForSha(f(n), 'https://h', 't', 1, 2, 'abc123', undefined)).resolves.toBe(false)
  })
  it('returns false when notes fetch fails (fail open toward running)', async () => {
    const n = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(hasCompletedReviewForSha(f(n), 'https://h', 't', 1, 2, 'abc123', BOT)).resolves.toBe(false)
  })
  it('detects an eyes running marker from the bot user', async () => {
    await expect(hasRunningEyes(f(awards([[BOT, 'eyes']])), 'https://h', 't', 1, 2, BOT)).resolves.toBe(true)
  })
  it('ignores eyes from a human reviewer', async () => {
    await expect(hasRunningEyes(f(awards([[7, 'eyes']])), 'https://h', 't', 1, 2, BOT)).resolves.toBe(false)
  })
  it('ignores eyes without a bot identity (fail open toward running)', async () => {
    await expect(hasRunningEyes(f(awards([[BOT, 'eyes']])), 'https://h', 't', 1, 2, undefined)).resolves.toBe(false)
  })
  it('ignores non-eyes awards', async () => {
    await expect(hasRunningEyes(f(awards([[BOT, 'white_check_mark']])), 'https://h', 't', 1, 2, BOT)).resolves.toBe(false)
  })
})
