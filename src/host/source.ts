/**
 * The producer-owned source kind this plugin stamps on every message it injects
 * into a review session.
 *
 * Session format v4 requires the producer to name itself (`plugin:<package>`)
 * and rejects the retired bare `kind: 'plugin'`. `kind: 'user'` is admissible
 * but false: these prompts are machine-initiated, and consumers classify a turn
 * by this kind — dsh-maestro-memory's write guard documents that
 * plugin-initiated turns carry no per-turn write duty.
 *
 * The reviewer and auditor sessions keep their own explicit
 * `sessionTitle.rename(...)`: the harness only auto-titles a `kind: 'user'`
 * message, so a plugin-attributed prompt feeds no title.
 *
 * Persisted legacy contract: the value keeps the package's former name
 * (renamed to `@ddtcorex/maestro-reviewer` in 0.13.0) because it is stamped
 * into session logs, and rehydrated sessions must keep recognising it.
 */
export const REVIEW_SOURCE_KIND = 'plugin:@ddtcorex/dsh-maestro-review'

// `MessageSourceMap` is the harness's merge-extensible sum type: each producer
// declares its own kind in its own module (see `goal-round-driver` and
// `schedule`), and there is deliberately no shared catch-all kind to reuse.
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:@ddtcorex/dsh-maestro-review': { readonly kind: 'plugin:@ddtcorex/dsh-maestro-review' }
  }
}
