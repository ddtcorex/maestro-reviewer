import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReviewerNote, markReviewerNote } from '../src/host/reviewer-note.js'

afterEach(() => vi.unstubAllGlobals())

describe('markReviewerNote', () => {
  it('adds the note marker to a body that has no reviewer marker', () => {
    expect(markReviewerNote('## Maestro Review: Reviewer failed\n\nboom')).toBe('## Maestro Review: Reviewer failed\n\nboom\n\n<!-- maestro-note -->')
  })
  it('leaves a marked body as it is', () => {
    const b = 'x\n\n<!-- maestro-review sha=abc1234 flow=ci-quick status=completed -->'
    expect(markReviewerNote(b)).toBe(b)
  })
  it('reads the unconfigured note as the reviewer', () => {
    expect(isReviewerNote({ body: 'Not configured.\n\n<!-- maestro-review-unconfigured -->' }, true)).toBe(true)
  })
})

describe('every note the reviewer posts carries a marker', () => {
  const captured: string[] = []
  const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') captured.push(JSON.parse(init.body ?? '{}').body)
    if (/\/merge_requests\/2$/.test(new URL(url).pathname)) return new Response(JSON.stringify({ diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))

  it('marks forge notes and replies', async () => {
    captured.length = 0; stub()
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://g', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 })
    await forge.postNote('Diff-only summary')
    await forge.replyToDiscussion('d1', 'Reviewer failed')
    expect(captured.every((b) => isReviewerNote({ body: b }, true))).toBe(true)
  })

  it('marks what the agent comment tools post', async () => {
    captured.length = 0; stub()
    const { gitlabForge } = await import('../src/host/forge/gitlab/index.js')
    const forge = gitlabForge({ baseUrl: 'https://g', token: 't', botUsername: 'bot' }, { projectId: 1, mrIid: 2 })
    const tools: any[] = []
    await forge.mountAgentTools({ plugin: async (mod: any, cfg: any) => mod.apply({ tools: { register: (t: any) => tools.push(t) } }, cfg) } as any, {})
    const byName = (n: string) => tools.find((t) => t.name === n)
    await byName('gitlab_post_mr_comment').execute({ body: 'A general note.' })
    await byName('gitlab_reply_to_thread').execute({ discussionId: 'd1', body: 'A reply.' })
    await byName('gitlab_post_inline_comment').execute({ path: 'a.php', line: 3, body: 'An inline note.' }).catch(() => {})
    expect(captured.length).toBeGreaterThanOrEqual(2)
    expect(captured.every((b) => isReviewerNote({ body: b }, true))).toBe(true)
  })
})
