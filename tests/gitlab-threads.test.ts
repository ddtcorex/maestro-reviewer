import { describe, it, expect } from 'vitest'
import { selectOwnThreads } from '../src/host/forge/gitlab/gitlab-client.js'

function note(author: string, body: string, extra: Record<string, unknown> = {}) {
  return { body, author: { username: author }, ...extra }
}

const pos = (path: string, line: number) => ({ new_path: path, new_line: line })

describe('selectOwnThreads', () => {
  it('returns an unresolved own inline thread', () => {
    const out = selectOwnThreads([
      { id: 'd1', notes: [note('review-bot', 'first', { position: pos('a.phtml', 10), resolved: false })] },
    ], 'review-bot')
    expect(out.threads).toHaveLength(1)
    expect(out.threads[0]).toMatchObject({ discussionId: 'd1', path: 'a.phtml', line: 10, resolved: false })
    expect(out.totalDiscussions).toBe(1)
  })

  it('includes resolved own threads with resolved:true instead of dropping them', () => {
    const out = selectOwnThreads([
      { id: 'd2', notes: [note('review-bot', 'old', { position: pos('b.php', 3), resolved: true })] },
    ], 'review-bot')
    expect(out.threads).toHaveLength(1)
    expect(out.threads[0].resolved).toBe(true)
  })

  it('treats a missing resolved flag as unresolved', () => {
    const out = selectOwnThreads([
      { id: 'd3', notes: [note('review-bot', 'x', { position: pos('c.php', 1) })] },
    ], 'review-bot')
    expect(out.threads).toHaveLength(1)
    expect(out.threads[0].resolved).toBe(false)
  })

  it('excludes other authors, position-less and empty threads but counts them in totalDiscussions', () => {
    const out = selectOwnThreads([
      { id: 'd4', notes: [note('someone', 'hi', { position: pos('a.phtml', 1), resolved: false })] },
      { id: 'd5', notes: [note('review-bot', 'general', { resolved: false })] },
      { id: 'd6', notes: [] },
    ], 'review-bot')
    expect(out.threads).toHaveLength(0)
    expect(out.totalDiscussions).toBe(3)
  })

  it('uses the last note body as lastCommentBody', () => {
    const out = selectOwnThreads([
      { id: 'd7', notes: [
        note('review-bot', 'first', { position: pos('a.phtml', 5), resolved: false }),
        note('review-bot', 'follow-up', { resolved: false }),
      ] },
    ], 'review-bot')
    expect(out.threads[0].lastCommentBody).toBe('follow-up')
  })
})

describe('fetchAllDiscussions', () => {
  it('follows x-next-page so threads past the first page reach the model', async () => {
    const { fetchAllDiscussions } = await import('../src/host/forge/gitlab/gitlab-client.js')
    const urls: string[] = []
    const pages: Record<string, { body: unknown[]; next: string }> = {
      '1': { body: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, notes: [] })), next: '2' },
      '2': { body: [{ id: 'late', notes: [] }], next: '' },
    }
    const fetcher = (async (url: string) => {
      urls.push(url)
      const page = new URL(url).searchParams.get('page') ?? '1'
      return new Response(JSON.stringify(pages[page].body), { headers: { 'x-next-page': pages[page].next } })
    }) as typeof fetch
    const all = await fetchAllDiscussions(fetcher, 'https://g/api/v4/projects/1/merge_requests/2', {})
    expect(all).toHaveLength(101)
    expect(all.at(-1)!.id).toBe('late')
    expect(urls.every((u) => u.includes('per_page=100'))).toBe(true)
  })

  it('fails on a page that does not load', async () => {
    const { fetchAllDiscussions } = await import('../src/host/forge/gitlab/gitlab-client.js')
    const fetcher = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(fetchAllDiscussions(fetcher, 'https://g/x', {})).rejects.toThrow(/500/)
  })
})
