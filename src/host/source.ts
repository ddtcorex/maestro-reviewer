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
 * The value tracks the current package name: it is stamped into session logs,
 * so a rename is a breaking change for rehydrated sessions and ships with a
 * major version.
 */
export const REVIEW_SOURCE_KIND = 'plugin:@ddtcorex/maestro-reviewer'

// `MessageSourceMap` is the harness's merge-extensible sum type: each producer
// declares its own kind in its own module (see `goal-round-driver` and
// `schedule`), and there is deliberately no shared catch-all kind to reuse.
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:@ddtcorex/maestro-reviewer': { readonly kind: 'plugin:@ddtcorex/maestro-reviewer' }
  }
}
