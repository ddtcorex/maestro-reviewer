import { describe, it, expect } from 'vitest'

describe('withAuditorDegrade', () => {
  it('withAuditorDegrade returns reviewer-only note when the auditor throws', async () => {
    const { withAuditorDegrade } = await import('../src/host/orchestrator.js')
    const wrapped = withAuditorDegrade(async () => { throw new Error('govard: binary not found') })
    await expect(wrapped('/tmp/x', {} as any)).resolves.toMatch(/reviewer-only/)
  })

  it('withAuditorDegrade passes auditor output through', async () => {
    const { withAuditorDegrade } = await import('../src/host/orchestrator.js')
    const wrapped = withAuditorDegrade(async () => 'audit says hi')
    await expect(wrapped('/tmp/x', {} as any)).resolves.toBe('audit says hi')
  })
})

describe('declineUnmappedDeepReview — dedup signal', () => {
  it('concurrent duplicate returns false (no double decline comment)', async () => {
    const { declineUnmappedDeepReview } = await import('../src/host/orchestrator.js')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let posts = 0
    const deps = {
      postComment: async () => { posts += 1; await gate },
      replyToDiscussion: async () => {},
      writeFailedReport: async () => {},
    }
    const payload = {
      projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b',
      mode: 'deep', scope: { kind: 'mr' }, trigger: 'mention',
    } as const
    const first = declineUnmappedDeepReview(payload as any, deps as any)
    const second = await declineUnmappedDeepReview(payload as any, deps as any)
    expect(second).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(posts).toBe(1)
  })
})
