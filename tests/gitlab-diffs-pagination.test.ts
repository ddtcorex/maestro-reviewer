import { describe, expect, it, vi } from 'vitest'
import { fetchAllDiffs, MAX_DIFF_FILES, diffToolText } from '../src/host/forge/gitlab/gitlab-client.js'
import { reviewerSummary } from '../src/host/orchestrator.js'

const diff = (i: number) => ({ old_path: `f${i}`, new_path: `f${i}`, diff: '+x' })

/** Pages of diffs; `next` controls the x-next-page header per page (undefined = header absent). */
function pager(sizes: number[], next?: Array<string | undefined>) {
  let id = 0
  const pages = sizes.map(n => Array.from({ length: n }, () => diff(id++)))
  const calls: string[] = []
  const fetcher = vi.fn(async (url: string) => {
    const u = new URL(url)
    calls.push(u.search)
    const page = Number(u.searchParams.get('page'))
    const header = next ? next[page - 1] : (page < pages.length ? String(page + 1) : '')
    const headers: Record<string, string> = header === undefined ? {} : { 'x-next-page': header }
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200, headers })
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

describe('fetchAllDiffs', () => {
  it('pages through 100, 100, 30 and returns all 230 diffs', async () => {
    const { fetcher, calls } = pager([100, 100, 30])
    const out = await fetchAllDiffs(fetcher, 'https://h/api/v4/projects/1/merge_requests/2', {})
    expect(out.diffs).toHaveLength(230)
    expect(out.truncated).toBe(false)
    expect(calls).toEqual(['?per_page=100&page=1', '?per_page=100&page=2', '?per_page=100&page=3'])
  })

  it('stops on an empty x-next-page', async () => {
    const { fetcher, calls } = pager([100, 5], ['2', ''])
    expect((await fetchAllDiffs(fetcher, 'https://h/x', {})).diffs).toHaveLength(105)
    expect(calls).toHaveLength(2)
  })

  it('stops on an empty page when the server sends no pagination headers', async () => {
    const { fetcher, calls } = pager([100, 20, 0], [undefined, undefined, undefined])
    expect((await fetchAllDiffs(fetcher, 'https://h/x', {})).diffs).toHaveLength(120)
    expect(calls).toHaveLength(3)
  })

  it('stops at the cap and flags the truncation', async () => {
    const { fetcher } = pager(Array.from({ length: 31 }, () => 100))
    const out = await fetchAllDiffs(fetcher, 'https://h/x', {})
    expect(MAX_DIFF_FILES).toBe(3000)
    expect(out.diffs).toHaveLength(3000)
    expect(out.truncated).toBe(true)
  })

  it('throws with the GitLab status on an error page', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(fetchAllDiffs(fetcher, 'https://h/x', {})).rejects.toThrow(/GitLab API error 500/)
  })
})

describe('truncation is visible', () => {
  it('to the model in the diff tool text', () => {
    expect(diffToolText({ path: '.maestro/mr-1.diff', bytes: 10, files: [{ path: 'a', bytes: 1 }] }, false)).toBe('diff written to .maestro/mr-1.diff (10 bytes, 1 files)')
    expect(diffToolText({ path: 'p', bytes: 10, files: [] }, true)).toMatch(/truncated at 3000 files/)
  })

  it('to the reader in the review summary', () => {
    expect(reviewerSummary(2, 1, false)).toBe('2 new inline comment(s), 1 thread(s) updated.')
    expect(reviewerSummary(0, 0, true)).toMatch(/Diff truncated at 3000 files/)
  })
})
