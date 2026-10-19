import { describe, expect, it } from 'vitest'
import { encodeReviewMeta, parseReviewMeta, findingFingerprint, buildReviewMeta, META_MAX_BYTES, type ReviewMeta } from '../src/host/review-marker.js'
import { normalizeFindings } from '../src/host/review-findings-tool.js'
import { buildReviewComment } from '../src/host/orchestrator.js'

const meta = (o: Partial<ReviewMeta> = {}): ReviewMeta => ({
  v: 1,
  headSha: 'a1b2c3d4e5f6',
  baseSha: '0f0f0f0f',
  mode: 'quick',
  models: ['deepseek-v4-flash'],
  findings: [{ code: 'SEC-XSS-ESCAPE', fingerprint: 'f1', severity: 'major' }],
  at: '2026-10-19T00:00:00.000Z',
  ...o,
})

describe('review metadata block', () => {
  it('round-trips through a note body', () => {
    const body = `## Review\n\ntext\n\n${encodeReviewMeta(meta())}`
    expect(parseReviewMeta(body)).toEqual(meta())
  })

  it('uses the v1 delimiters and a base64url payload', () => {
    expect(encodeReviewMeta(meta())).toMatch(/^<!-- maestro-review-meta:v1 [A-Za-z0-9_-]+ -->$/)
  })

  it('returns undefined for a missing, truncated, foreign-version or non-JSON block', () => {
    const good = encodeReviewMeta(meta())
    expect(parseReviewMeta('no block here')).toBeUndefined()
    expect(parseReviewMeta(good.slice(0, 40))).toBeUndefined()
    expect(parseReviewMeta(good.replace('meta:v1', 'meta:v2'))).toBeUndefined()
    expect(parseReviewMeta(`<!-- maestro-review-meta:v1 ${Buffer.from('not json').toString('base64url')} -->`)).toBeUndefined()
  })

  it('returns undefined when the payload has the wrong shape (a human edit or a spoof)', () => {
    const enc = (o: unknown) => `<!-- maestro-review-meta:v1 ${Buffer.from(JSON.stringify(o)).toString('base64url')} -->`
    expect(parseReviewMeta(enc({ ...meta(), v: 2 }))).toBeUndefined()
    expect(parseReviewMeta(enc({ ...meta(), headSha: 42 }))).toBeUndefined()
    expect(parseReviewMeta(enc({ ...meta(), mode: 'turbo' }))).toBeUndefined()
    expect(parseReviewMeta(enc({ ...meta(), findings: [{ code: 1 }] }))).toBeUndefined()
  })

  it('stays under the size cap by dropping findings and flagging the truncation', () => {
    const findings = Array.from({ length: 500 }, (_, i) => ({ code: `CODE-${i}`, fingerprint: 'x'.repeat(40), severity: 'minor' }))
    const block = encodeReviewMeta(meta({ findings }))
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(META_MAX_BYTES)
    const parsed = parseReviewMeta(block)!
    expect(parsed.truncated).toBe(true)
    expect(parsed.findings.length).toBeGreaterThan(0)
    expect(parsed.findings.length).toBeLessThan(500)
  })
})

describe('findingFingerprint', () => {
  const base = { status: 'new' as const, path: 'a/B.php', line: 10, code: 'SEC-XSS-ESCAPE', body: 'Escape  the\noutput' }
  it('is stable when the finding moves to another line or whitespace changes', () => {
    expect(findingFingerprint({ ...base, line: 42 })).toBe(findingFingerprint(base))
    expect(findingFingerprint({ ...base, body: 'Escape the output' })).toBe(findingFingerprint(base))
  })
  it('differs across codes and paths, and falls back to the category then none', () => {
    expect(findingFingerprint({ ...base, code: 'PERF-N1' })).not.toBe(findingFingerprint(base))
    expect(findingFingerprint({ ...base, path: 'a/C.php' })).not.toBe(findingFingerprint(base))
    const { code: _c, ...noCode } = base
    expect(findingFingerprint({ ...noCode, category: 'security' })).not.toBe(findingFingerprint(noCode))
    expect(findingFingerprint(noCode)).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('buildReviewMeta', () => {
  it('lists each finding by code, fingerprint and severity, never by body text', () => {
    const m = buildReviewMeta({
      headSha: 'abc', mode: 'deep', models: ['m'],
      findings: [{ status: 'new', path: 'p', body: 'secret-ish body text', severity: 'blocking', code: 'SEC-X' }, { status: 'new', body: 'b' }],
      now: () => new Date('2026-10-19T00:00:00Z'),
    })
    expect(m.findings).toEqual([
      { code: 'SEC-X', fingerprint: expect.stringMatching(/^[0-9a-f]{40}$/), severity: 'blocking' },
      { code: 'none', fingerprint: expect.stringMatching(/^[0-9a-f]{40}$/), severity: 'minor' },
    ])
    expect(JSON.stringify(m)).not.toContain('secret-ish')
    expect(m.at).toBe('2026-10-19T00:00:00.000Z')
  })
})

describe('normalizeFindings', () => {
  it('keeps a well-formed code and drops a malformed one without rejecting the finding', () => {
    const out = normalizeFindings([
      { status: 'new', body: 'a', code: 'SEC-XSS-ESCAPE' },
      { status: 'new', body: 'b', code: 'not a code' },
    ])
    expect(out[0].code).toBe('SEC-XSS-ESCAPE')
    expect(out[1]).not.toHaveProperty('code')
    expect(out[1].body).toBe('b')
  })
})

describe('buildReviewComment with metadata', () => {
  it('embeds exactly one metadata block after the marker', () => {
    const body = buildReviewComment({
      projectPath: 'g/p', mrIid: 1, gitlabBaseUrl: 'https://gitlab.example.com', mode: 'quick', summary: 's', failures: [],
      marker: { sha: 'a1b2c3d4e5f6', flow: 'ci-quick' }, meta: meta(),
    })
    expect(body.match(/maestro-review-meta:v1/g)).toHaveLength(1)
    expect(body.indexOf('maestro-review sha=')).toBeLessThan(body.indexOf('maestro-review-meta:v1'))
    expect(parseReviewMeta(body)).toEqual(meta())
  })

  it('adds no block without a marker', () => {
    const body = buildReviewComment({ projectPath: 'g/p', mrIid: 1, gitlabBaseUrl: 'https://x', mode: 'quick', summary: 's', failures: [], meta: meta() })
    expect(body).not.toContain('maestro-review-meta')
  })
})

describe('review flows embed metadata in the posted comment', () => {
  const finding = { status: 'new' as const, path: 'a/B.php', line: 3, body: 'Escape output', severity: 'major' as const, code: 'SEC-XSS-ESCAPE' }
  const payload = (headSha?: string) => ({
    projectId: 7, mrIid: 201, projectPath: 'g/p', sourceBranch: 'feat/x', targetBranch: 'master',
    trigger: 'mention', mode: 'quick', scope: { kind: 'mr' }, ...(headSha ? { headSha } : {}),
  }) as never

  it('runReviewAndAudit posts the reviewer findings as metadata', async () => {
    const { runReviewAndAudit } = await import('../src/host/orchestrator.js')
    const posted: string[] = []
    await runReviewAndAudit(payload('abc123'), {
      localRepoPath: '/r', ensureWorktree: async () => '/tmp/w', removeWorktree: async () => {},
      runReviewer: async () => ({ summary: '1 new inline comment(s), 0 thread(s) updated.', failures: [], findings: [finding], models: ['m-1'] }),
      runAuditor: async () => '', postComment: async (b: string) => { posted.push(b) }, replyToDiscussion: async () => {}, writeFailedReport: async () => {},
      gitlabBaseUrl: 'https://gitlab.example.com',
    } as never)
    const meta = parseReviewMeta(posted[0])!
    expect(meta.headSha).toBe('abc123')
    expect(meta.models).toEqual(['m-1'])
    expect(meta.findings).toEqual([{ code: 'SEC-XSS-ESCAPE', fingerprint: findingFingerprint(finding), severity: 'major' }])
  })

  it('runDiffOnlyReview posts metadata too', async () => {
    const { runDiffOnlyReview } = await import('../src/host/orchestrator.js')
    const posted: string[] = []
    await runDiffOnlyReview(payload('def456'), {
      runReviewer: async () => ({ summary: 's', failures: [], findings: [finding] }),
      postComment: async (b: string) => { posted.push(b) }, replyToDiscussion: async () => {}, writeFailedReport: async () => {},
      gitlabBaseUrl: 'https://gitlab.example.com',
    } as never)
    expect(parseReviewMeta(posted[0])?.headSha).toBe('def456')
  })
})
