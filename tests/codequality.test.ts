import { describe, expect, it, vi } from 'vitest'
import { toCodeQuality } from '../src/host/codequality.js'
import { findingFingerprint } from '../src/host/review-marker.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

const f = (severity: string, o: Record<string, unknown> = {}) => ({ status: 'new', path: 'app/A.php', line: 4, body: 'Missing escaping. Use escapeHtml.\nMore detail.', severity, code: 'SEC-XSS', ...o }) as any

describe('toCodeQuality', () => {
  it('maps severities and reuses the finding fingerprint', () => {
    const issues = toCodeQuality([f('nit'), f('minor', { line: 5 }), f('major', { line: 6 }), f('blocking', { line: 7 })])
    expect(issues.map((i) => i.severity)).toEqual(['info', 'minor', 'major', 'critical'])
    expect(issues[0]).toEqual({
      description: 'SEC-XSS: Missing escaping.', check_name: 'SEC-XSS', fingerprint: findingFingerprint(f('nit')),
      severity: 'info', location: { path: 'app/A.php', lines: { begin: 4 } },
    })
  })

  it('skips replies and findings without a position, and names uncoded findings by category', () => {
    const issues = toCodeQuality([f('minor', { status: 'reply', path: undefined, discussionId: 'd' }), f('minor', { line: undefined }), f('minor', { code: undefined, category: 'perf' })])
    expect(issues.map((i) => i.check_name)).toEqual(['perf'])
  })
})


describe('ci report files and exit code', () => {
  const run = async (engineResult: Record<string, unknown>, env: Record<string, string> = {}) => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', ...env })
    const fetcher = vi.fn(async (url: string) => url.endsWith('/user') ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
      : /notes|award_emoji/.test(url) ? new Response('[]', { status: 200 })
        : url.includes('/repository/files/') ? new Response('', { status: 404 })
          : new Response(JSON.stringify({ source_branch: 'b', target_branch: 'main', sha: 'abc' }), { status: 200 }))
    const writes = new Map<string, string>()
    const writeFile = (async (p: string, d: string) => { writes.set(p, d) }) as any
    const result = await runCiTrigger({ reviewEngine: { run: vi.fn(async () => engineResult) } } as any, cfg, { fetcher: fetcher as any, writeFile })
    return { writes, result }
  }

  it('writes the code quality report, an empty list when nothing was found', async () => {
    const { writes } = await run({ ok: true, summary: 's', failures: [], durationMs: 1, findings: [f('major')] })
    expect(JSON.parse(writes.get('gl-code-quality-report.json')!)).toHaveLength(1)
    const empty = await run({ ok: true, summary: 'already reviewed', failures: [], durationMs: 0 })
    expect(JSON.parse(empty.writes.get('gl-code-quality-report.json')!)).toEqual([])
  })


  it('refuses an unknown gate value', async () => {
    const { parseCiEnvConfig } = await import('../src/host/providers/ci-trigger.js')
    expect(() => parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', REVIEW_GATE: 'strict' })).toThrow(/REVIEW_GATE/)
  })
})

describe('engine result', () => {
  it('returns the findings of the run', async () => {
    const { createReviewEngine } = await import('../src/host/engine.js')
    const forge = {
      mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined, reviewScope: async () => ({ files: [{ path: 'a', bytes: 1 }], skipped: [] }),
      restrictToInterdiff: () => {}, postNote: async () => {}, replyToDiscussion: async () => {}, postFindings: async () => {},
      signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
    }
    const r = await createReviewEngine({} as any, { reviewer: vi.fn(async () => ({ summary: 'ok', failures: [], findings: [f('major')] })), auditor: vi.fn() } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any },
    )
    expect(r.findings).toEqual([f('major')])
  })
})

describe('child pipeline', () => {
  it('exposes the report to GitLab and keeps it with the other artifacts', async () => {
    const { childPipelineYaml } = await import('../src/host/ci-resolve.js')
    const y = JSON.parse(childPipelineYaml({ sourceProjectId: 1, mrIid: 2, gitlabHost: 'h', route: 'default', image: 'i', deep: false } as any))
    expect(y.review.artifacts.reports).toEqual({ codequality: 'gl-code-quality-report.json' })
    expect(y.review.artifacts.paths).toContain('gl-code-quality-report.json')
  })
})

