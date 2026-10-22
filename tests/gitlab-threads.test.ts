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

describe('own threads carry the finding and the human replies', () => {
  const finding = '🟡 Major · `BUG-SKIP`\n\n**A skipped run keeps a stale summary.**\n\nLong reasoning here.'

  it('keeps the finding head when a human replied last', () => {
    const out = selectOwnThreads([
      { id: 'd1', notes: [
        note('review-bot', finding, { position: pos('a.php', 9), resolved: true }),
        note('author', 'Documented in the docblock, keeping it.'),
      ] },
    ], 'review-bot')
    expect(out.threads[0].finding).toBe('🟡 Major · `BUG-SKIP` **A skipped run keeps a stale summary.**')
    expect(out.threads[0].humanReplies).toEqual(['Documented in the docblock, keeping it.'])
    expect(out.threads[0].lastCommentBody).toBe('Documented in the docblock, keeping it.')
  })

  it('leaves the bot own follow-ups out of humanReplies', () => {
    const out = selectOwnThreads([
      { id: 'd2', notes: [
        note('review-bot', finding, { position: pos('a.php', 9) }),
        note('author', 'Not a bug.'),
        note('review-bot', 'Agreed.'),
      ] },
    ], 'review-bot')
    expect(out.threads[0].humanReplies).toEqual(['Not a bug.'])
  })

  it('lists a fallback thread posted without a position, under its path and line', () => {
    const out = selectOwnThreads([
      { id: 'd3', notes: [note('review-bot', '**Inline fallback — `src/A.php:40` line is not in current MR diff**\n\n' + finding, { resolved: true })] },
    ], 'review-bot')
    expect(out.threads).toHaveLength(1)
    expect(out.threads[0]).toMatchObject({ discussionId: 'd3', path: 'src/A.php', line: 40, finding: '🟡 Major · `BUG-SKIP` **A skipped run keeps a stale summary.**' })
  })

  it('caps a long human reply', () => {
    const out = selectOwnThreads([
      { id: 'd4', notes: [note('review-bot', finding, { position: pos('a.php', 1) }), note('author', 'x'.repeat(5000))] },
    ], 'review-bot')
    expect(out.threads[0].humanReplies[0].length).toBeLessThanOrEqual(2001)
  })
})

describe('final review fixes: thread list', () => {
  const finding = '🟡 Major · `BUG-SKIP`\n\n**Title.**'

  it('ignores GitLab system notes for replies and the last comment', () => {
    const out = selectOwnThreads([
      { id: 'd1', notes: [
        note('review-bot', finding, { position: pos('a.php', 9) }),
        note('author', 'By design.'),
        note('author', 'changed this line in version 3 of the diff', { system: true }),
      ] },
    ], 'review-bot')
    expect(out.threads[0].humanReplies).toEqual(['By design.'])
    expect(out.threads[0].lastCommentBody).toBe('By design.')
  })

  it('keeps the list small: the last three replies, each capped, and a capped last comment', () => {
    const replies = Array.from({ length: 6 }, (_, i) => note('author', `r${i} ` + 'x'.repeat(3000)))
    const out = selectOwnThreads([{ id: 'd2', notes: [note('review-bot', finding, { position: pos('a.php', 1) }), ...replies] }], 'review-bot')
    expect(out.threads[0].humanReplies).toHaveLength(3)
    expect(out.threads[0].humanReplies[0].startsWith('r3 ')).toBe(true)
    expect(out.threads[0].humanReplies.every((r) => r.length <= 1000)).toBe(true)
    expect(out.threads[0].lastCommentBody.length).toBeLessThanOrEqual(1000)
  })

  it('redacts human replies', () => {
    const out = selectOwnThreads([{ id: 'd3', notes: [note('review-bot', finding, { position: pos('a.php', 1) }), note('author', "'password' => 'hunter22'")] }], 'review-bot')
    expect(out.threads[0].humanReplies[0]).not.toContain('hunter22')
  })

  it('lists a fallback thread for a deleted file', () => {
    const out = selectOwnThreads([{ id: 'd4', notes: [note('review-bot', '**Inline fallback — `old/A.php:7` was deleted in this MR (no line to attach a comment to)**\n\n' + finding)] }], 'review-bot')
    expect(out.threads[0]).toMatchObject({ path: 'old/A.php', line: 7, finding: '🟡 Major · `BUG-SKIP` **Title.**' })
  })

  it('stops on a page that repeats forever', async () => {
    const { fetchAllDiscussions } = await import('../src/host/forge/gitlab/gitlab-client.js')
    const fetcher = (async () => new Response(JSON.stringify([{ id: 'x', notes: [] }]), { headers: { 'x-next-page': '2' } })) as unknown as typeof fetch
    await expect(fetchAllDiscussions(fetcher, 'https://g/x', {})).rejects.toThrow(/pages/)
  })
})
