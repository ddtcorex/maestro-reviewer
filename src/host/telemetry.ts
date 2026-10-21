import { readSessionEvents } from './orchestrator.js'

/**
 * Per-run telemetry (spec section 6, P2): stage wall clock and model token
 * usage, written to review-report.json and summed into the review metadata.
 * Every later performance change is judged on these numbers.
 */

export type Stage = 'boot' | 'fetch' | 'clone' | 'agent' | 'post'

export interface StageTimer {
  /** Attributes the time since the previous mark, minus `excludeMs`, to `stage`. */
  mark(stage: Stage, excludeMs?: number): void
  /** Adds a duration measured elsewhere. */
  add(stage: Stage, ms: number): void
  toJSON(): Partial<Record<Stage, number>>
}

export function createStageTimer(now: () => number = Date.now): StageTimer {
  const totals: Partial<Record<Stage, number>> = {}
  let last = now()
  const add = (stage: Stage, ms: number) => { totals[stage] = (totals[stage] ?? 0) + Math.max(0, Math.round(ms)) }
  return {
    mark(stage, excludeMs = 0) {
      const t = now()
      add(stage, t - last - excludeMs)
      last = t
    },
    add,
    toJSON: () => ({ ...totals }),
  }
}

export interface TokenUsage { input: number; output: number; cached: number }

export interface AgentUsage { agent: 'reviewer' | 'auditor'; model: string; usage: TokenUsage | null }

/**
 * Token usage of one agent session. DSH has no separate usage record: the
 * adapter's accounting rides on each `assistant/message` event as
 * `data.usage` (`TokenUsage` of @deepseek-ai/dsh-llm: `inputTokens`,
 * `outputTokens`, optional `cacheReadTokens`), and is absent when the
 * provider reported none. Read it before the handle is disposed: disposing
 * deletes the session log. Null when no message carried usage.
 */
export function usageFromSession(session: unknown): TokenUsage | null {
  try { return readUsage(session) } catch { return null }
}

function readUsage(session: unknown): TokenUsage | null {
  let found = false
  const total: TokenUsage = { input: 0, output: 0, cached: 0 }
  for (const event of readSessionEvents(session)) {
    const e = event as { type?: unknown; data?: { usage?: { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown } } }
    const u = e?.type === 'assistant/message' ? e.data?.usage : undefined
    if (u === undefined || u === null) continue
    found = true
    total.input += typeof u.inputTokens === 'number' ? u.inputTokens : 0
    total.output += typeof u.outputTokens === 'number' ? u.outputTokens : 0
    total.cached += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
  }
  return found ? total : null
}

export function sumUsage(list: Array<TokenUsage | null>): TokenUsage | null {
  const known = list.filter((u): u is TokenUsage => u !== null)
  if (known.length === 0) return null
  return known.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached }), { input: 0, output: 0, cached: 0 })
}
