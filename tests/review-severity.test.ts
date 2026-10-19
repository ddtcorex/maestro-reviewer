import { describe, it, expect } from 'vitest'
import { buildReviewComment } from '../src/host/orchestrator.js'
import { countFindingSeverities, severityPrefix } from '../src/host/severity.js'
import { postReviewFindings } from '../src/host/forge/gitlab/mr-api.js'

const DIFF_REFS = { base_sha: 'b', start_sha: 's', head_sha: 'h' }
const DIFF = '@@ -1,2 +1,3 @@\n context\n+added\n context2'
const CHANGE = { old_path: 'a.php', new_path: 'a.php', diff: DIFF }

function poster(calls: unknown[]) {
  return {
    baseUrl: 'https://git.example', token: 't', projectId: 1, mrIid: 9,
    fetcher: ((_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return Promise.resolve({ ok: true })
    }) as typeof fetch,
    snapshot: Promise.resolve({ diffRefs: DIFF_REFS, changes: [CHANGE] }),
  }
}

describe('severityPrefix', () => {
  it('maps each level to its emoji label', () => {
    expect(severityPrefix('blocking')).toBe('🔴 Blocking')
    expect(severityPrefix('major')).toBe('🟡 Major')
    expect(severityPrefix('minor')).toBe('🔵 Minor')
    expect(severityPrefix('nit')).toBe('⚪ Nit')
  })
  it('falls back to minor for missing or unknown levels', () => {
    expect(severityPrefix(undefined)).toBe('🔵 Minor')
    expect(severityPrefix('whatever' as never)).toBe('🔵 Minor')
  })
})

describe('countFindingSeverities', () => {
  it('counts per level and treats missing severity as minor', () => {
    expect(countFindingSeverities([
      { status: 'new', body: 'a', path: 'a.php', line: 1, severity: 'blocking' },
      { status: 'new', body: 'b', path: 'a.php', line: 2, severity: 'nit' },
      { status: 'reply', body: 'c', discussionId: 'd1' },
    ])).toEqual({ blocking: 1, nit: 1, minor: 1 })
  })
  it('omits zero counts', () => {
    expect(countFindingSeverities([])).toEqual({})
  })
})

describe('postReviewFindings severity prefix', () => {
  it('prefixes the posted body with the severity label', async () => {
    const calls: unknown[] = []
    await postReviewFindings(
      [{ status: 'new', body: 'boom', path: 'a.php', line: 2, severity: 'blocking' }],
      poster(calls) as never,
    )
    expect((calls[0] as { body: string }).body.startsWith('🔴 Blocking')).toBe(true)
  })
  it('defaults a missing severity to minor without double-prefixing', async () => {
    const calls: unknown[] = []
    await postReviewFindings(
      [
        { status: 'new', body: 'plain', path: 'a.php', line: 2 },
        { status: 'new', body: '🔵 Minor\n\nquoted', path: 'a.php', line: 2 },
      ],
      poster(calls) as never,
    )
    expect((calls[0] as { body: string }).body.startsWith('🔵 Minor')).toBe(true)
    expect((calls[1] as { body: string }).body).toBe('🔵 Minor\n\nquoted')
  })
})

describe('buildReviewComment severity breakdown', () => {
  const base = {
    projectPath: 'g/p', mrIid: 7, gitlabBaseUrl: 'https://git.example',
    mode: 'deep', summary: 's', failures: [] as string[],
    findings: { newCount: 2, replyCount: 1 },
  }
  it('appends non-zero severity counts in fixed order', () => {
    const out = buildReviewComment({
      ...base,
      findings: { newCount: 2, replyCount: 1, severityCounts: { blocking: 1, nit: 2 } },
    })
    expect(out).toContain('🔴 1 blocking')
    expect(out).toContain('⚪ 2 nit')
    expect(out.indexOf('🔴')).toBeLessThan(out.indexOf('⚪'))
  })
  it('leaves the findings line unchanged when no counts are given', () => {
    const out = buildReviewComment(base)
    expect(out).toContain('**Findings:** 💬 2 new · 🔁 1 updated')
  })
})
