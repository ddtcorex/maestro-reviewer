import { describe, expect, it, vi } from 'vitest'
import { threadStates } from '../src/host/forge/gitlab/gitlab-client.js'
import { fetchMrVersions } from '../src/host/forge/gitlab/mr-api.js'
import { effectiveReply, isAnsweredUnchanged, openerSeverity } from '../src/host/finding-filters.js'
import type { ThreadState } from '../src/host/forge/types.js'

const note = (author: string, body: string, created_at: string, extra: Record<string, unknown> = {}) => ({ body, author: { username: author }, created_at, resolved: false, ...extra })
const pos = { new_path: 'a.php', new_line: 20 }

describe('openerSeverity', () => {
  it('reads the label at the start', () => {
    expect(openerSeverity('🟡 Major · `X-CODE`\n\nbody')).toBe('major')
  })

  it('reads the label after an inline fallback line', () => {
    expect(openerSeverity('**Inline fallback \u2014 `a.php:3` is outside the files this MR changes**\n\n🔴 Blocking · `X`\n\nbody')).toBe('blocking')
  })

  it('is undefined for unknown text', () => {
    expect(openerSeverity('Hello')).toBeUndefined()
  })
})

describe('threadStates', () => {
  it('reports severity and who spoke last', () => {
    const [t] = threadStates([{ id: 'd1', notes: [
      note('bot', '🟡 Major · `X`\n\nbody', '2026-11-01T10:00:00Z', { position: pos }),
      note('dev', 'By design.', '2026-11-01T11:00:00Z'),
      note('bot', 'gitlab system note', '2026-11-01T12:00:00Z', { system: true }),
    ] }], 'bot')
    expect(t).toEqual({ discussionId: 'd1', path: 'a.php', line: 20, severity: 'major', lastHumanAt: '2026-11-01T11:00:00Z', lastBotAt: '2026-11-01T10:00:00Z', lastIsHuman: true })
  })

  it('is not answered when the bot spoke last', () => {
    const [t] = threadStates([{ id: 'd2', notes: [
      note('bot', '🔵 Minor · `X`', '2026-11-01T10:00:00Z', { position: pos }),
      note('dev', 'Why?', '2026-11-01T11:00:00Z'),
      note('bot', 'Because.', '2026-11-01T12:00:00Z'),
    ] }], 'bot')
    expect(t.lastIsHuman).toBe(false)
  })

  it('reads an inline fallback opener', () => {
    const [t] = threadStates([{ id: 'd3', notes: [note('bot', '**Inline fallback \u2014 `b.php:7` was deleted in this MR**\n\n⚪ Nit · `X`', '2026-11-01T10:00:00Z')] }], 'bot')
    expect(t).toMatchObject({ path: 'b.php', line: 7, severity: 'nit' })
  })

  it('skips threads the bot did not open', () => {
    expect(threadStates([{ id: 'd4', notes: [note('dev', 'hi', '2026-11-01T10:00:00Z', { position: pos })] }], 'bot')).toEqual([])
  })
})

describe('fetchMrVersions', () => {
  it('maps head sha and creation time', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ id: 2, head_commit_sha: 'h2', created_at: '2026-11-02T00:00:00Z' }]), { status: 200 }))
    expect(await fetchMrVersions('https://g', 't', 1, 5, fetcher as unknown as typeof fetch)).toEqual([{ headSha: 'h2', createdAt: '2026-11-02T00:00:00Z' }])
    expect(String(fetcher.mock.calls[0][0])).toBe('https://g/api/v4/projects/1/merge_requests/5/versions?per_page=100')
  })

  it('is undefined on an API error', async () => {
    const fetcher = vi.fn(async () => new Response('no', { status: 500 }))
    expect(await fetchMrVersions('https://g', 't', 1, 5, fetcher as unknown as typeof fetch)).toBeUndefined()
  })
})

const answered: ThreadState = { discussionId: 'd', path: 'a.php', line: 20, severity: 'major', lastHumanAt: '2026-11-02T12:00:00Z', lastBotAt: '2026-11-02T10:00:00Z', lastIsHuman: true }
const versions = [{ headSha: 'h1', createdAt: '2026-11-01T00:00:00Z' }, { headSha: 'h2', createdAt: '2026-11-02T00:00:00Z' }, { headSha: 'h3', createdAt: '2026-11-03T00:00:00Z' }]
const hunk = (path: string, start: number, count: number) => ({ new_path: path, old_path: path, diff: `@@ -${start},${count} +${start},${count} @@\n-x\n+y\n` })

describe('isAnsweredUnchanged', () => {
  it('is false when the bot spoke last', async () => {
    const compare = vi.fn()
    expect(await isAnsweredUnchanged({ ...answered, lastIsHuman: false }, { versions, compare, headSha: 'h3' })).toBe(false)
    expect(compare).not.toHaveBeenCalled()
  })

  it('is true when later commits touch only another file', async () => {
    const compare = vi.fn(async () => ({ diffs: [hunk('b.php', 20, 1)] }))
    expect(await isAnsweredUnchanged(answered, { versions, compare, headSha: 'h3' })).toBe(true)
    expect(compare).toHaveBeenCalledWith('h2', 'h3')
  })

  it('is false when later commits touch the thread lines within 5', async () => {
    const compare = vi.fn(async () => ({ diffs: [hunk('a.php', 24, 2)] }))
    expect(await isAnsweredUnchanged(answered, { versions, compare, headSha: 'h3' })).toBe(false)
  })

  it('is true when the change is further than 5 lines away', async () => {
    const compare = vi.fn(async () => ({ diffs: [hunk('a.php', 40, 2)] }))
    expect(await isAnsweredUnchanged(answered, { versions, compare, headSha: 'h3' })).toBe(true)
  })

  it('judges the thread line on the old side when earlier lines shifted it', async () => {
    // 50 lines inserted at the top, then line 100 (the thread's, at the answer) edited: now line 150.
    const diff = '@@ -0,0 +1,50 @@\n+new\n@@ -100,1 +150,1 @@\n-x\n+y\n'
    const compare = vi.fn(async () => ({ diffs: [{ new_path: 'a.php', old_path: 'a.php', diff }] }))
    expect(await isAnsweredUnchanged({ ...answered, line: 100 }, { versions, compare, headSha: 'h3' })).toBe(false)
  })

  it('treats a file diff without a readable hunk as touching', async () => {
    const compare = vi.fn(async () => ({ diffs: [{ new_path: 'a.php', old_path: 'a.php', diff: '' }] }))
    expect(await isAnsweredUnchanged(answered, { versions, compare, headSha: 'h3' })).toBe(false)
  })

  it('treats any change to the file as touching an unpositioned thread', async () => {
    const compare = vi.fn(async () => ({ diffs: [hunk('a.php', 400, 1)] }))
    expect(await isAnsweredUnchanged({ ...answered, line: null }, { versions, compare, headSha: 'h3' })).toBe(false)
  })

  it('orders times by instant, not by text, across GitLab time formats', async () => {
    // As text, '12:00:00.500Z' sorts before '12:00:00Z'; the version came half a second after the answer.
    const mixed = [{ headSha: 'h2', createdAt: '2026-11-02T11:00:00+00:00' }, { headSha: 'h3', createdAt: '2026-11-02T12:00:00.500Z' }]
    const compare = vi.fn(async () => ({ diffs: [hunk('a.php', 20, 1)] }))
    expect(await isAnsweredUnchanged({ ...answered, lastHumanAt: '2026-11-02T12:00:00Z' }, { versions: mixed, compare, headSha: 'h3' })).toBe(false)
    expect(compare).toHaveBeenCalledWith('h2', 'h3')
  })

  it('fails open on an unreadable answer time', async () => {
    expect(await isAnsweredUnchanged({ ...answered, lastHumanAt: 'yesterday' }, { versions, compare: vi.fn(), headSha: 'h3' })).toBe(false)
  })

  it('fails open without versions or compare', async () => {
    expect(await isAnsweredUnchanged(answered, { versions: undefined, compare: vi.fn(), headSha: 'h3' })).toBe(false)
    expect(await isAnsweredUnchanged(answered, { versions, compare: vi.fn(async () => undefined), headSha: 'h3' })).toBe(false)
  })

  it('is true without a compare when the head has not moved since the answer', async () => {
    const compare = vi.fn()
    expect(await isAnsweredUnchanged(answered, { versions: versions.slice(0, 2), compare, headSha: 'h2' })).toBe(true)
    expect(compare).not.toHaveBeenCalled()
  })
})

describe('effectiveReply', () => {
  const thread: ThreadState = { ...answered, lastIsHuman: false }
  it('gives a reply without severity the thread severity', () => {
    expect(effectiveReply({ status: 'reply', discussionId: 'd', body: 'x' }, thread)).toMatchObject({ severity: 'major', threadSeverity: 'major' })
  })

  it('keeps a reply severity that differs', () => {
    expect(effectiveReply({ status: 'reply', discussionId: 'd', body: 'x', severity: 'minor' }, thread)).toMatchObject({ severity: 'minor', threadSeverity: 'major' })
  })

  it('leaves the finding unchanged without thread state', () => {
    const f = { status: 'reply' as const, discussionId: 'd', body: 'x' }
    expect(effectiveReply(f, undefined)).toBe(f)
  })
})
