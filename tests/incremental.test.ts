import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIncrementalBlock } from '../src/host/incremental.js'
import { fetchCompare, fetchMrDetailHeadSha } from '../src/host/forge/gitlab/mr-api.js'
import type { CompareResult } from '../src/host/forge/types.js'
import { recordReviewStart, recordReviewFinish, lastCompletedReview } from '../src/host/review-history.js'

const cleanup: string[] = []
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maestro-history-'))
  cleanup.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('buildIncrementalBlock', () => {
  const compare: CompareResult = {
    commits: [
      { short_id: 'abc1234', title: 'fix: typo in template' },
      { short_id: 'def5678', title: 'feat: add widget' },
    ],
    diffs: [{ new_path: 'app/design/frontend/Vendor/theme/a.phtml' }, { new_path: 'app/code/Vendor/Module/etc/config.xml' }],
  }

  it('returns a prompt block naming commits and changed-file scope since the last reviewed sha', () => {
    const block = buildIncrementalBlock(compare, 'oldsha1111', 'newsha2222')
    expect(block).toBeDefined()
    expect(block).toContain('fix: typo in template')
    expect(block).toContain('Changed files since last review: 2')
    expect(block).toContain('oldsha1111')
  })

  it('returns undefined when there is nothing to compare', () => {
    expect(buildIncrementalBlock(undefined, 'a', 'b')).toBeUndefined()
    expect(buildIncrementalBlock({ commits: [], diffs: [] }, 'a', 'b')).toBeUndefined()
  })

  it('returns undefined when the reviewed sha equals the current head', () => {
    expect(buildIncrementalBlock(compare, 'same', 'same')).toBeUndefined()
  })

  it('caps long commit lists without losing the scope summary', () => {
    const many: CompareResult = {
      commits: Array.from({ length: 45 }, (_, i) => ({ short_id: `c${i}`, title: `commit ${i}` })),
      diffs: [{ new_path: 'x.txt' }],
    }
    const block = buildIncrementalBlock(many, 'old', 'new')!
    const listed = (block.match(/^- /g) ?? []).length
    expect(listed).toBeLessThanOrEqual(21) // 20 + the "and N more" line is not a `- ` bullet
    expect(block).toContain('and 25 more commit(s)')
  })
})

describe('lastCompletedReview', () => {
  it('returns the newest completed entry for the MR, ignoring running and failed ones', async () => {
    const home = await tempHome()
    await recordReviewStart({
      id: '1', projectId: 7, projectPath: 'p', mrIid: 9, mode: 'quick', scope: 'mr',
      trigger: 'push', startedAt: 1, headSha: 'aaa',
    }, home)
    await recordReviewFinish('1', { status: 'completed' }, home)
    await recordReviewStart({
      id: '2', projectId: 7, projectPath: 'p', mrIid: 9, mode: 'quick', scope: 'mr',
      trigger: 'push', startedAt: 2, headSha: 'bbb',
    }, home)
    await recordReviewStart({
      id: '3', projectId: 7, projectPath: 'p', mrIid: 9, mode: 'quick', scope: 'mr',
      trigger: 'push', startedAt: 3, headSha: 'ccc',
    }, home)
    await recordReviewFinish('3', { status: 'failed' }, home)

    const last = await lastCompletedReview(7, 9, home)
    expect(last).toBeDefined()
    expect(last!.id).toBe('1')
    expect(last!.headSha).toBe('aaa')
  })

  it('returns undefined when no completed review exists for this MR', async () => {
    const home = await tempHome()
    expect(await lastCompletedReview(7, 9, home)).toBeUndefined()
  })
})

describe('D1 pre-agent fetch timeout', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.useRealTimers()
  })

  /** Hanging stub that honors abort, like real fetch: rejects with AbortError. */
  function hangUntilAborted(): void {
    // @ts-expect-error minimal stub: hangs until aborted, then rejects like real fetch
    globalThis.fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          )
        }),
    )
  }

  it('fetchMrDetailHeadSha degrades to undefined when the API hangs', async () => {
    vi.useFakeTimers()
    hangUntilAborted()
    const pending = fetchMrDetailHeadSha('https://git.example.com', 'tok', 1345, 30)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toBeUndefined()
  })

  it('fetchCompare degrades to undefined when the API hangs', async () => {
    vi.useFakeTimers()
    hangUntilAborted()
    const pending = fetchCompare('https://git.example.com', 'tok', 1345, 'aaa', 'bbb')
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toBeUndefined()
  })
})
