import { describe, expect, it, vi } from 'vitest'
import { runReviewAndAudit } from '../src/host/orchestrator.js'
import type { ReviewRequest } from '../src/host/events.js'

function payload(mode: 'quick' | 'deep', mrIid: number): ReviewRequest {
  return {
    projectId: 7, mrIid, projectPath: 'g/p', sourceBranch: 'feat/x', targetBranch: 'master',
    trigger: 'mention', mode, scope: { kind: 'mr' },
  } as unknown as ReviewRequest
}

function makeDeps(calls: string[], over: Record<string, unknown> = {}) {
  return {
    localRepoPath: '/repo',
    ensureWorktree: async () => '/tmp/maestro-mr-7-1',
    removeWorktree: async (wt: string) => { calls.push(`remove:${wt}`) },
    runReviewer: async () => ({ summary: '0 new inline comment(s), 0 thread(s) updated.', failures: [] }),
    runAuditor: async () => '## audit',
    postComment: async () => {},
    replyToDiscussion: async () => {},
    writeFailedReport: async () => {},
    ...over,
  }
}

describe('runReviewAndAudit environment teardown', () => {
  it('tears the environment down before removing the worktree after a deep audit', async () => {
    const calls: string[] = []
    await runReviewAndAudit(payload('deep', 101), makeDeps(calls, {
      teardownEnvironment: async (wt: string) => { calls.push(`teardown:${wt}`) },
    }) as never)
    expect(calls).toEqual(['teardown:/tmp/maestro-mr-7-1', 'remove:/tmp/maestro-mr-7-1'])
  })

  it('tears down even when the auditor throws', async () => {
    const calls: string[] = []
    await runReviewAndAudit(payload('deep', 102), makeDeps(calls, {
      runAuditor: async () => { throw new Error('model skipped the teardown and died') },
      teardownEnvironment: async (wt: string) => { calls.push(`teardown:${wt}`) },
    }) as never)
    expect(calls).toEqual(['teardown:/tmp/maestro-mr-7-1', 'remove:/tmp/maestro-mr-7-1'])
  })

  it('does not tear down for a quick review (no auditor ran)', async () => {
    const calls: string[] = []
    await runReviewAndAudit(payload('quick', 103), makeDeps(calls, {
      teardownEnvironment: async (wt: string) => { calls.push(`teardown:${wt}`) },
    }) as never)
    expect(calls).toEqual(['remove:/tmp/maestro-mr-7-1'])
  })

  it('does nothing extra when no teardown is wired (CI flow)', async () => {
    const calls: string[] = []
    await runReviewAndAudit(payload('deep', 104), makeDeps(calls) as never)
    expect(calls).toEqual(['remove:/tmp/maestro-mr-7-1'])
  })

  it('still removes the worktree and returns when the teardown throws', async () => {
    const calls: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = await runReviewAndAudit(payload('deep', 105), makeDeps(calls, {
      teardownEnvironment: async () => { throw new Error('docker gone') },
    }) as never)
    expect(calls).toEqual(['remove:/tmp/maestro-mr-7-1'])
    expect(body).toContain('audit')
    warn.mockRestore()
  })
})
