import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-title'
import { createReviewEngine, type ReviewEngine } from './engine.js'

/** Row `maestro-review-engine`: provides the review engine to the CI trigger and to host plugins. */
export const name = 'maestro-review-engine'
export const inject = ['agentDefaultModel', 'agents', 'agentPresets', 'sessionTitle']

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewEngine: ReviewEngine
  }
}

export function apply(ctx: Context): void {
  ctx.provide('reviewEngine', createReviewEngine(ctx))
}
