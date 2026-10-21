import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { buildPeriodicReport, discoverReviewReports, parseReportEnv, renderReportMarkdown, runReport } from '../src/host/ci-report.js'

const job = (id: number, name: string, created: string) => ({ id, name, created_at: created })
const report = (o: Record<string, unknown>) => ({ ok: true, summary: 'done', failures: [], durationMs: 1000, projectId: 10, mrIid: 1, mode: 'quick', ...o })

function stub(pages: unknown[][], reports: Record<number, unknown>) {
  return vi.fn(async (url: string) => {
    const art = /\/jobs\/(\d+)\/artifacts\/review-report\.json$/.exec(url)
    if (art) return reports[Number(art[1])] === undefined ? new Response('', { status: 404 }) : new Response(JSON.stringify(reports[Number(art[1])]), { status: 200 })
    if (url.includes('/jobs?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200, headers: { 'x-next-page': page < pages.length ? String(page + 1) : '' } })
    }
    return new Response('{}', { status: 404 })
  })
}

describe('discoverReviewReports', () => {
  it('reads the review jobs of the window and stops at the first older page', async () => {
    const fetcher = stub([
      [job(9, 'review', '2026-10-20T10:00:00Z'), job(8, 'resolve', '2026-10-20T09:00:00Z'), job(7, 'review', '2026-10-19T10:00:00Z')],
      [job(6, 'review', '2026-10-10T10:00:00Z'), job(5, 'review', '2026-10-09T10:00:00Z')],
      [job(4, 'review', '2026-10-01T10:00:00Z')],
    ], { 9: report({ mrIid: 3 }), 6: report({}) })
    const reports = await discoverReviewReports(fetcher as any, { apiBase: 'https://g/api/v4', token: 't', reviewerProjectId: 2, since: new Date('2026-10-14T00:00:00Z') })
    expect(reports.map((r) => r.mrIid)).toEqual([3])
    expect(fetcher.mock.calls.filter(([u]) => String(u).includes('/jobs?'))).toHaveLength(2)
    expect(fetcher.mock.calls.some(([u]) => String(u).includes('/jobs/6/'))).toBe(false)
  })
})

describe('buildPeriodicReport', () => {
  it('sums runs, MRs, findings, tokens and tool calls per project, and counts skipped runs apart', () => {
    const r = buildPeriodicReport([
      report({ mrIid: 1, findings: [{ severity: 'major' }, { severity: 'minor' }], usage: [{ agent: 'reviewer', model: 'm', usage: { input: 100, output: 10, cached: 50 } }], toolCalls: { read: 3, hyva_csp_scan: 1 } }),
      report({ mrIid: 1, summary: 'already reviewed at abc, skipping' }),
      report({ mrIid: 2, findings: [{ severity: 'major' }], usage: [{ agent: 'reviewer', model: 'm', usage: null }], toolCalls: { read: 1 } }),
      report({ projectId: 11, mrIid: 5, ok: false, failures: ['boom'] }),
    ], { since: '2026-10-14T00:00:00.000Z', projectPaths: new Map([[10, 'g/app']]) })
    expect(r.projects).toEqual([
      { projectId: 10, path: 'g/app', mrs: 2, runs: 2, skipped: 1, failed: 0, findings: { major: 2, minor: 1 }, tokens: { input: 100, output: 10, cached: 50 } },
      { projectId: 11, path: 'project/11', mrs: 1, runs: 1, skipped: 0, failed: 1, findings: {}, tokens: { input: 0, output: 0, cached: 0 } },
    ])
    expect(r.toolCalls).toEqual({ hyva_csp_scan: 1, read: 4 })
  })

  it('renders a markdown table in the Maestro Review style', () => {
    const md = renderReportMarkdown(buildPeriodicReport([report({ findings: [{ severity: 'major' }] })], { since: '2026-10-14T00:00:00.000Z', projectPaths: new Map([[10, 'g/app']]) }))
    expect(md).toContain('## 🤖 Maestro Review: report since 2026-10-14')
    expect(md).toContain('| `g/app` | 1 | 1 | 0 | 0 | 1 major |')
    expect(md).toContain('Tool calls')
  })
})

describe('parseReportEnv', () => {
  it('defaults to 7 days, caps at 30 and refuses anything else', () => {
    const base = { REVIEW_GITLAB_TOKEN: 't', CI_API_V4_URL: 'https://g/api/v4', CI_PROJECT_ID: '2' }
    expect(parseReportEnv(base).days).toBe(7)
    expect(parseReportEnv({ ...base, REVIEW_REPORT_DAYS: '30' }).days).toBe(30)
    expect(() => parseReportEnv({ ...base, REVIEW_REPORT_DAYS: '31' })).toThrow(/REVIEW_REPORT_DAYS/)
    expect(() => parseReportEnv({ ...base, REVIEW_REPORT_DAYS: 'x' })).toThrow(/REVIEW_REPORT_DAYS/)
    expect(() => parseReportEnv({ CI_API_V4_URL: 'u', CI_PROJECT_ID: '2' })).toThrow(/REVIEW_GITLAB_TOKEN/)
  })
})

describe('runReport', () => {
  it('writes the json and markdown reports and never prints the token', async () => {
    const fetcher = stub([[job(9, 'review', new Date().toISOString())]], { 9: report({ findings: [{ severity: 'minor' }] }) })
    const writes = new Map<string, string>()
    const logs: string[] = []
    const code = await runReport({ REVIEW_GITLAB_TOKEN: 'secret-token', CI_API_V4_URL: 'https://g/api/v4', CI_PROJECT_ID: '2' }, {
      fetcher: fetcher as any, writeFile: async (p, t) => { writes.set(p, t) }, log: (l) => logs.push(l), now: () => new Date(),
    })
    expect(code).toBe(0)
    expect(JSON.parse(writes.get('periodic-report.json')!).projects[0].runs).toBe(1)
    expect(writes.get('periodic-report.md')).toContain('Maestro Review')
    expect(logs.join('\n')).not.toContain('secret-token')
  })
})

describe('pipeline wiring', () => {
  it('runs the report job only on a schedule, and keeps review reports for 30 days', async () => {
    const t = parse(readFileSync('templates/reviewer-project.gitlab-ci.yml', 'utf8'))
    expect(t.report.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule"' }])
    expect(t.report.script).toEqual(['/report.sh'])
    expect(t.report.artifacts.paths).toEqual(['periodic-report.json', 'periodic-report.md'])
    expect(t.resolve.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "pipeline"' }])
    const { childPipelineYaml } = await import('../src/host/ci-resolve.js')
    const y = JSON.parse(childPipelineYaml({ sourceProjectId: 1, mrIid: 2, gitlabHost: 'h', route: 'default', image: 'i', deep: false } as any))
    expect(y.review.artifacts.expire_in).toBe('30 days')
    expect(readFileSync('docker/Dockerfile', 'utf8')).toContain('COPY docker/report.sh /report.sh')
  })
})
