import { describe, it, expect, vi, afterEach } from 'vitest'
import { createReviewSignals } from '../src/host/forge/gitlab/review-signals.js'

describe('review-signals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs when clearing the running marker fails, instead of swallowing it silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.start()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('review-signals'), expect.anything())
  })

  it('logs when awarding the final marker fails, instead of swallowing it silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      // unawardOwn's GET listing succeeds with no matching awards
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      // the award POST itself fails
      .mockRejectedValueOnce(new Error('timeout'))
    vi.stubGlobal('fetch', fetchMock)

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.finish('completed')

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('review-signals'), expect.anything())
  })

  it('logs when the GET listing responds non-ok (expired token, rate-limit) instead of resolving silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' }))

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.start()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('review-signals'), expect.anything())
  })

  it('logs when the award POST responds non-ok instead of leaving the marker unset with no trace', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Too Many Requests' })
    vi.stubGlobal('fetch', fetchMock)

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.start()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('review-signals'), expect.anything())
  })

  it('logs a non-ok DELETE for one stale marker but still processes the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      // unawardOwn's GET listing: two stale eyes markers from this bot
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 10, name: 'eyes', user: { username: 'maestro-bot' } },
          { id: 11, name: 'eyes', user: { username: 'maestro-bot' } },
        ],
      })
      // first DELETE fails with a non-ok response (not a thrown error)
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' })
      // second DELETE succeeds
      .mockResolvedValueOnce({ ok: true })
      // final award succeeds
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.finish('completed')

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('404'))
    // both DELETEs (id 10 and 11) plus the GET and the award POST = 4 calls
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('clears a stale terminal marker of the same name before re-awarding it (prevents duplicate-name 404)', async () => {
    const fetchMock = vi.fn()
      // unawardOwn's GET listing: a leftover white_check_mark from a prior completed run
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 20, name: 'white_check_mark', user: { username: 'maestro-bot' } }],
      })
      // DELETE the stale white_check_mark
      .mockResolvedValueOnce({ ok: true })
      // award the fresh white_check_mark
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.finish('completed')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(deleteUrl).toContain('/award_emoji/20')
    expect(deleteInit.method).toBe('DELETE')
  })

  it('does not log anything when both calls succeed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)

    const signals = createReviewSignals({
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      projectId: 1,
      mrIid: 2,
      botUsername: 'maestro-bot',
    })
    await signals.start()
    await signals.finish('failed')

    expect(errorSpy).not.toHaveBeenCalled()
  })
})
