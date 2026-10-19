export interface MrOpenedPayload {
  projectPath: string
  projectId: number
  mrIid: number
  sourceBranch: string
}

export type ReviewMode = 'quick' | 'deep'

export type ReviewScope =
  | { kind: 'mr' }
  | { kind: 'discussion'; discussionId: string; path: string; line: number }

import type { ReviewSkillProfile } from './skills-tool.js'

export interface ReviewRequest extends MrOpenedPayload {
  /** `push` arrives only when auto re-review on push is enabled and passes the completed-history gate. */
  trigger: 'reviewer-assignment' | 'mention' | 'push'
  mode: ReviewMode
  scope: ReviewScope
  /**
   * CI-only override (ci-trigger sets it from REVIEW_PROFILE). The GitLab webhook
   * producer never sets it — mapped projects resolve their profile from the mapping.
   * Undefined preserves the legacy diff-only generic review.
   */
  reviewProfile?: ReviewSkillProfile
  /**
   * CI-only: MR head SHA from fetchMrDetail (ci-trigger sets it). Feeds the
   * comment marker so later CI runs can yield to this review. The GitLab
   * webhook producer never sets it — webhook comments stay marker-free.
   */
  headSha?: string
  /**
   * CI-only: head SHA of the newest completed review, read from GitLab by
   * ci-trigger. The orchestrator's incremental block prefers it over the
   * local history store, which is runner-local in CI.
   */
  priorHeadSha?: string
  /** Short (8-char) head-sha hint for `push` triggers, taken from the webhook
   * body — feeds the in-flight key so two concurrent pushes stop deduping
   * each other. Absent when the body carries no sha. */
  pushSha?: string
}

export interface ReviewResult {
  /** false = the review could not run or failed outright (infra error) — a CI caller should exit non-zero. */
  ok: boolean
  summary?: string
  failures: string[]
  durationMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'maestro/review-request': (payload: ReviewRequest) => void
  }
  interface Context {
    reviewRunner: (payload: ReviewRequest) => Promise<ReviewResult>
  }
}
