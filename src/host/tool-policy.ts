import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'maestro-review-tool-policy'

/**
 * Host-level tools that leak into every agent but make no sense for a review
 * agent: review sessions must stay read-only on the worktree and side-effect
 * free on the harness (no personal memory writes, no todo lists, no plugin
 * marketplace suggestions, no sidebar UI, no nested subagents).
 *
 * Deny-listed rather than allow-listed on purpose: DSH has no per-agent tool
 * scoping yet, and a reviewer genuinely needs the shared search/read/gitlab
 * surface — an allow-list would break on every new host capability.
 */
export const REVIEW_DENIED_TOOLS: readonly string[] = [
  'memory',
  'memory_suggest',
  'dtodo',
  'find_dsh_plugin',
  'sidebar_open',
  'subagent_claude_code',
  'subagent_codex',
]

/** Pure predicate: returns the denial reason for denied tools, else undefined. */
export function deniedToolForReview(toolName: string): string | undefined {
  if (!REVIEW_DENIED_TOOLS.includes(toolName)) return undefined
  return `Tool "${toolName}" is not available to Maestro review agents: reviews stay read-only on the worktree and side-effect free on the harness.`
}

export function createReviewToolPolicyHandler(onToolCall?: (toolName: string) => void): (
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
) => Promise<PreToolDecision> {
  return async (exec, next) => {
    const toolName = exec.name ?? ''
    // Every attempt counts, denied ones too: the counts decide which review
    // tools are worth keeping.
    onToolCall?.(toolName)
    const reason = deniedToolForReview(toolName)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }
}

/** Agent-scoped: register inside an agent setup fiber so the policy dies with that agent. */
export interface Config {
  onToolCall?: (toolName: string) => void
}

export function apply(ctx: Context, config: Config = {}): void {
  const handler = createReviewToolPolicyHandler(config.onToolCall)
  ctx.effect(() => ctx.on('tools/pre-execute', handler))
}
