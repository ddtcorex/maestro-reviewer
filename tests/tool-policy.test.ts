import { describe, it, expect } from 'vitest'
import {
  deniedToolForReview,
  createReviewToolPolicyHandler,
  REVIEW_DENIED_TOOLS,
} from '../src/host/tool-policy.js'
import * as policyPlugin from '../src/host/tool-policy.js'

describe('review tool policy', () => {
  it('denies exactly the leaked host tools with an explanatory reason', () => {
    for (const tool of REVIEW_DENIED_TOOLS) {
      expect(deniedToolForReview(tool)).toContain('not available to Maestro review agents')
    }
    expect(deniedToolForReview('grep')).toBeUndefined()
    expect(deniedToolForReview('gitlab_list_mr_diffs')).toBeUndefined()
    expect(deniedToolForReview('report_review_findings')).toBeUndefined()
  })

  it('handler denies without calling next for listed tools', async () => {
    const handler = createReviewToolPolicyHandler()
    let nextCalled = false
    const decision = await handler({ name: 'memory' }, async () => {
      nextCalled = true
      return { kind: 'allow' as const }
    })
    expect(decision.kind).toBe('deny')
    expect(nextCalled).toBe(false)
  })

  it('handler delegates to next for allowed tools', async () => {
    const handler = createReviewToolPolicyHandler()
    let nextCalled = false
    const decision = await handler({ name: 'grep' }, async () => {
      nextCalled = true
      return { kind: 'allow' as const }
    })
    expect(decision.kind).toBe('allow')
    expect(nextCalled).toBe(true)
  })

  it('names no tool that nothing registers any more', () => {
    expect(REVIEW_DENIED_TOOLS).not.toContain('maestro_write_file')
  })

  it('reports every attempted tool call, allowed or denied, to the counter', async () => {
    const seen: string[] = []
    const handler = createReviewToolPolicyHandler((name) => seen.push(name))
    await handler({ name: 'grep' }, async () => ({ kind: 'allow' as const }))
    await handler({ name: 'memory' }, async () => ({ kind: 'allow' as const }))
    await handler({ name: 'grep' }, async () => ({ kind: 'allow' as const }))
    expect(seen).toEqual(['grep', 'memory', 'grep'])
  })

  it('is a registerable plugin whose apply wires the pre-execute listener', () => {
    expect(policyPlugin.name).toBe('maestro-review-tool-policy')
    const listeners: Array<[string, unknown]> = []
    const effects: Array<() => void> = []
    const ctx = {
      on(event: string, handler: unknown) { listeners.push([event, handler]) },
      effect(fn: () => void) { effects.push(fn) },
    }
    policyPlugin.apply(ctx as never)
    // ctx.effect registers immediately in real cordis; invoke the callback here.
    effects[0]()
    expect(listeners).toHaveLength(1)
    expect(listeners[0][0]).toBe('tools/pre-execute')
    expect(typeof listeners[0][1]).toBe('function')
  })
})
