import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterDiffs, DEFAULT_IGNORE_GLOBS } from '../src/host/diff-filter.js'
import { planIncremental } from '../src/host/incremental.js'
import { usageFromSession } from '../src/host/telemetry.js'
import { buildCommandPrompt } from '../src/host/ci-commands.js'
import { timedFetcher } from '../src/host/forge/gitlab/gitlab-client.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('ignore globs in dot directories', () => {
  it('match files under a dot directory too', () => {
    const d = (p: string) => ({ old_path: p, new_path: p })
    expect(filterDiffs([d('app/.cache/x.min.js'), d('.yarn/cache/pnpm-lock.yaml'), d('.github/workflows/ci.yml')], DEFAULT_IGNORE_GLOBS).skipped)
      .toEqual(['app/.cache/x.min.js', '.yarn/cache/pnpm-lock.yaml'])
  })
})

describe('compare limits', () => {
  it('is not an interdiff after a compare timeout or at the file limit', () => {
    const one = { old_path: 'a', new_path: 'a', diff: 'x' }
    expect(planIncremental({ headSha: 'a', baseSha: 'b' }, { headSha: 'c', baseSha: 'b' }, { diffs: [one], compare_timeout: true } as any)).toEqual({ kind: 'full', reason: 'interdiff too large' })
    expect(planIncremental({ headSha: 'a', baseSha: 'b' }, { headSha: 'c', baseSha: 'b' }, { diffs: Array(1000).fill(one) } as any)).toEqual({ kind: 'full', reason: 'interdiff too large' })
  })
})

describe('usage', () => {
  it('never throws on a session that throws', () => {
    expect(usageFromSession({ ownEvents: () => { throw new Error('disposed') } })).toBeNull()
  })
})

describe('answer prompt', () => {
  it('keeps the agent off the report and thread tools', () => {
    const p = buildCommandPrompt({ kind: 'explain' }, { path: 'a', line: 1, body: 'x' })
    expect(p).toMatch(/do not call report_review_findings/i)
  })
})

describe('timedFetcher', () => {
  it('aborts a request that never answers', async () => {
    const hang = vi.fn((_u: string, init: RequestInit = {}) => new Promise<Response>((_r, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))) }))
    await expect(timedFetcher(hang as any, 20)('https://g/x')).rejects.toThrow(/timeout after 20ms/)
  })
})

describe('ci parse', () => {
  it('refuses a half-set deep model pair', async () => {
    const { parseCiEnvConfig } = await import('../src/host/providers/ci-trigger.js')
    const base = { GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' }
    expect(() => parseCiEnvConfig({ ...base, REVIEW_DEEP_MODEL: 'm' })).toThrow(/REVIEW_DEEP_MODEL_PROVIDER/)
    expect(() => parseCiEnvConfig({ ...base, REVIEW_DEEP_MODEL_PROVIDER: 'p' })).toThrow(/REVIEW_DEEP_MODEL/)
  })
})

const forgeWith = (o: Record<string, unknown> = {}) => ({
  mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined,
  reviewScope: async () => ({ files: [{ path: 'a.php', bytes: 1 }], skipped: [] }),
  postNote: async () => {}, replyToDiscussion: async () => {}, postFindings: async () => {},
  signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {}, ...o,
})
async function run(forge: any, reviewer: (...a: any[]) => Promise<any>, extra: Record<string, unknown> = {}) {
  const { createReviewEngine } = await import('../src/host/engine.js')
  return createReviewEngine({} as any, { reviewer: vi.fn(reviewer), auditor: vi.fn() } as any).run(
    { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
    { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge, ...extra },
  )
}

describe('engine', () => {
  it('works with a forge that has none of the optional members', async () => {
    const r = await run(forgeWith(), async () => ({ summary: 'ok', failures: [] }))
    expect(r.ok).toBe(true)
  })

  it('does not repost a deterministic finding that already has an open thread', async () => {
    const posted: any[] = []
    const forge = forgeWith({
      reviewScope: async () => ({ files: [{ path: 'm/etc/db_schema.xml', bytes: 1 }], skipped: [] }),
      openFindingKeys: async () => new Set(['MAGENTO-DB-WHITELIST@m/etc/db_schema.xml']),
      postFindings: async (fs: any[]) => { posted.push(...fs) },
    })
    await run(forge, async () => ({ summary: 'ok', failures: [] }))
    expect(posted).toEqual([])
  })

  it('names every distinct reason when every part fails', async () => {
    let n = 0
    const many = Array.from({ length: 4 }, (_, i) => ({ path: `src/M${i}/a.php`, bytes: 1 }))
    const r = await run(forgeWith({ reviewScope: async () => ({ files: many, skipped: [] }) }), async () => { throw new Error(n++ % 2 === 0 ? 'timeout' : 'rate limited') }, { fanout: { files: 1, bytes: 1_000_000, concurrency: 2 } })
    expect(r.failures[0]).toMatch(/every review part failed: .*timeout.*rate limited|rate limited.*timeout/)
  })

  it('returns what was posted for the report: deterministic findings in, muted and below-floor out', async () => {
    const forge = forgeWith({
      reviewScope: async () => ({ files: [{ path: 'm/etc/db_schema.xml', bytes: 1 }], skipped: [] }),
      feedback: async () => new Map([['RIG-MUTED', 5]]),
    })
    const { postFindingsSequentially } = await import('../src/host/engine.js')
    const r = await run(forge, async (_w: unknown, _p: unknown, runCfg: any) => {
      const found = [
        { status: 'new', path: 'a.php', line: 1, body: 'x', severity: 'major', code: 'RIG-KEEP' },
        { status: 'new', path: 'a.php', line: 2, body: 'y', severity: 'minor', code: 'RIG-MUTED' },
        { status: 'new', path: 'a.php', line: 3, body: 'z', severity: 'nit', code: 'RIG-LOW' },
      ] as any[]
      const p = await postFindingsSequentially(runCfg.forge, found, { minSeverity: 'minor', muted: runCfg.mutedCodes })
      return { summary: 'ok', failures: [], findings: found, postedFindings: p.posted }
    })
    expect((r.findings ?? []).map((f: any) => f.code).sort()).toEqual(['MAGENTO-DB-WHITELIST', 'RIG-KEEP'])
  })
})

describe('review-report.json', () => {
  it('keeps code, severity, path and line of findings, never their bodies', async () => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' })
    const fetcher = vi.fn(async (url: string) => url.endsWith('/user') ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
      : /notes|award_emoji|discussions/.test(url) ? new Response('[]', { status: 200 })
        : url.includes('/repository/files/') ? new Response('', { status: 404 })
          : new Response(JSON.stringify({ source_branch: 'b', sha: 'abc', default_branch: 'main' }), { status: 200 }))
    const writes = new Map<string, string>()
    await runCiTrigger({ reviewEngine: { run: vi.fn(async () => ({ ok: true, failures: [], durationMs: 1, findings: [{ status: 'new', path: 'a.php', line: 3, body: 'secret details here', severity: 'major', code: 'X-Y' }] })) } } as any, cfg,
      { fetcher: fetcher as any, writeFile: (async (p: string, d: string) => { writes.set(p, d) }) as any })
    const report = writes.get('review-report.json')!
    expect(JSON.parse(report).findings).toEqual([{ code: 'X-Y', severity: 'major', path: 'a.php', line: 3 }])
    expect(report).not.toContain('secret details here')
    expect(writes.get('gl-code-quality-report.json')).toContain('X-Y')
  })
})

describe('fan-out over a capped diff (I4)', () => {
  it('marks the review partial', async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ path: `src/M${i}/a.php`, bytes: 1 }))
    const r = await run(forgeWith({ reviewScope: async () => ({ files: many, skipped: [], truncated: true }) }), async () => ({ summary: 'ok', failures: [] }), { fanout: { files: 1, bytes: 1_000_000, concurrency: 2 } })
    expect(r.partial).toBe(true)
  })
})
