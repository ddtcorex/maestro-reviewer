import { describe, it, expect } from 'vitest'
import { buildReviewerScopePrompt } from '../src/host/orchestrator.js'

const LINT = { worktreePath: '/tmp/wt', base: 'abc123' }

describe('buildReviewerScopePrompt', () => {
  it('mandates at least one govard CLI lint run through the bash tool for full reviews', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'deep', profileInstruction: '', lint: LINT })
    expect(prompt).toMatch(/MUST run the govard lint with the bash tool at least once/)
    expect(prompt).toContain('govard audit run --checks lint --format json --mode auto --timeout auto --lint-provider govard --scope diff --base "abc123"')
    expect(prompt).toContain('report_review_findings exactly once')
  })
  it('mandates lint for discussion-scope reviews too', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'discussion', discussionId: 'd1', path: 'a.php', line: 10, profileInstruction: '', lint: LINT })
    expect(prompt).toMatch(/MUST run the govard lint with the bash tool at least once/)
  })
  it('never calls a retired govard tool', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'deep', profileInstruction: '', lint: LINT })
    expect(prompt).not.toMatch(/govard_[a-z_]+/)
  })
  it('keeps a lint run that cannot execute from failing or blocking the review', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'deep', profileInstruction: '', lint: LINT })
    expect(prompt).toMatch(/not a finding/)
    expect(prompt).toMatch(/lint was unavailable/)
  })
  it('keeps the dedup rule for full reviews', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: LINT })
    expect(prompt).toContain('DEDUP RULE')
  })
  it('warns against filing findings positioned on a deleted file', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: LINT })
    expect(prompt).toMatch(/DELETED FILES/)
    expect(prompt).toMatch(/never (file|post) a finding (located |positioned )?on a deleted file/i)
  })

  // The lint rule is conditional: it is only demanded when the bash tool and a
  // govard binary are both available, and it carries the MR base sha and the
  // worktree in the command because nothing wires them as defaults.
  it('names the worktree and base the reviewer must pass', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'deep', profileInstruction: '', lint: LINT })
    expect(prompt).toContain('workdir "/tmp/wt"')
    expect(prompt).toContain('--base "abc123"')
    expect(prompt).not.toContain('no base arg needed')
  })
  it('omits the lint rule entirely when the bash tool or the govard binary is not available', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'deep', profileInstruction: '', lint: null })
    expect(prompt).not.toContain('govard audit')
    expect(prompt).not.toContain('LINT RULE')
    // Everything else about the review still stands.
    expect(prompt).toContain('report_review_findings')
    expect(prompt).toContain('DEDUP RULE')
  })
  it('drops the lint rule from a discussion prompt too, and keeps the rest', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'discussion', discussionId: 'd1', path: 'a.php', line: 10, profileInstruction: '', lint: null })
    expect(prompt).not.toContain('LINT RULE')
    expect(prompt).toContain('gitlab_get_mr_diff')
    expect(prompt).toContain('d1')
  })
})
describe('finding filter fields in the prompt', () => {
  it('asks for premise and evidence and keeps the existing rules', () => {
    const prompt = buildReviewerScopePrompt({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: LINT })
    expect(prompt).toContain('premise "external"')
    expect(prompt).toContain('in quick mode it is listed in the summary, not posted as a thread')
    expect(prompt).toContain('Give major and blocking findings evidence')
    expect(prompt).toContain('UNVERIFIED RULE')
    expect(prompt).toContain('SETTLED THREAD RULE')
  })
})
