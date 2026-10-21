import { gitlabAuthHeaders } from './forge/gitlab/gitlab-auth.js'
import { SEVERITY_ORDER } from './severity.js'

/**
 * Periodic report (spec section 7, F7): a scheduled reviewer pipeline job
 * aggregates the reviewer project's own `review` job reports
 * (review-report.json) over the last REVIEW_REPORT_DAYS. Pipeline variables
 * are forbidden on the reviewer project, so discovery reads the job
 * artifacts the bot (Reporter) can read; nothing else is configured.
 */

export interface ReviewReport {
  ok: boolean
  summary?: string
  failures: string[]
  projectId: number
  mrIid: number
  findings?: Array<{ severity?: string }>
  usage?: Array<{ usage: { input: number; output: number; cached: number } | null }>
  toolCalls?: Record<string, number>
}

export interface ProjectRow {
  projectId: number
  path: string
  mrs: number
  runs: number
  skipped: number
  failed: number
  findings: Record<string, number>
  tokens: { input: number; output: number; cached: number }
}

export interface PeriodicReport { since: string; projects: ProjectRow[]; toolCalls: Record<string, number> }

const MAX_PAGES = 50
const MAX_DAYS = 30

export async function discoverReviewReports(
  fetcher: typeof fetch, opts: { apiBase: string; token: string; reviewerProjectId: number; since: Date },
): Promise<ReviewReport[]> {
  const headers = gitlabAuthHeaders(opts.token)
  const out: ReviewReport[] = []
  let page = '1'
  for (let i = 0; page !== '' && i < MAX_PAGES; i++) {
    const res = await fetcher(`${opts.apiBase}/projects/${opts.reviewerProjectId}/jobs?scope[]=success&scope[]=failed&per_page=100&page=${page}`, { headers })
    if (!res.ok) throw new Error(`GitLab API error ${res.status} listing jobs`)
    const jobs = await res.json() as Array<{ id: number; name: string; created_at: string }>
    const inWindow = jobs.filter((j) => new Date(j.created_at) >= opts.since)
    for (const j of inWindow.filter((x) => x.name === 'review')) {
      const a = await fetcher(`${opts.apiBase}/projects/${opts.reviewerProjectId}/jobs/${j.id}/artifacts/review-report.json`, { headers })
      if (!a.ok) continue
      const r = await a.json() as ReviewReport
      if (typeof r.projectId === 'number' && typeof r.mrIid === 'number') out.push(r)
    }
    // Jobs come newest first: a page that ends before the window ends the walk.
    if (jobs.length === 0 || inWindow.length < jobs.length) break
    page = res.headers.get('x-next-page') ?? ''
  }
  return out
}

/** Pure. Skipped runs (push-gate, coexistence) are counted apart from reviews. */
export function buildPeriodicReport(reports: ReviewReport[], opts: { since: string; projectPaths: Map<number, string> }): PeriodicReport {
  const rows = new Map<number, ProjectRow & { mrSet: Set<number> }>()
  const toolCalls: Record<string, number> = {}
  for (const r of reports) {
    const row = rows.get(r.projectId) ?? { projectId: r.projectId, path: opts.projectPaths.get(r.projectId) ?? `project/${r.projectId}`, mrs: 0, runs: 0, skipped: 0, failed: 0, findings: {}, tokens: { input: 0, output: 0, cached: 0 }, mrSet: new Set<number>() }
    rows.set(r.projectId, row)
    row.mrSet.add(r.mrIid)
    if (!r.ok) row.failed++
    if (r.ok && /skipping/.test(r.summary ?? '')) { row.skipped++; continue }
    row.runs++
    for (const f of r.findings ?? []) { const s = f.severity ?? 'minor'; row.findings[s] = (row.findings[s] ?? 0) + 1 }
    for (const u of r.usage ?? []) if (u.usage !== null) { row.tokens.input += u.usage.input; row.tokens.output += u.usage.output; row.tokens.cached += u.usage.cached }
    for (const [tool, n] of Object.entries(r.toolCalls ?? {})) toolCalls[tool] = (toolCalls[tool] ?? 0) + n
  }
  return {
    since: opts.since,
    projects: [...rows.values()].sort((a, b) => a.projectId - b.projectId).map(({ mrSet, ...row }) => ({ ...row, mrs: mrSet.size })),
    toolCalls: Object.fromEntries(Object.entries(toolCalls).sort(([a], [b]) => a.localeCompare(b))),
  }
}

export function renderReportMarkdown(r: PeriodicReport): string {
  const sev = (f: Record<string, number>) => SEVERITY_ORDER.filter((s) => (f[s] ?? 0) > 0).map((s) => `${f[s]} ${s}`).join(', ') || 'none'
  const rows = r.projects.map((p) => `| \`${p.path}\` | ${p.mrs} | ${p.runs} | ${p.skipped} | ${p.failed} | ${sev(p.findings)} | ${p.tokens.input} / ${p.tokens.output} / ${p.tokens.cached} |`)
  const tools = Object.entries(r.toolCalls).map(([t, n]) => `| \`${t}\` | ${n} |`)
  return [
    `## 🤖 Maestro Review: report since ${r.since.slice(0, 10)}`, '',
    '| Project | MRs | Reviews | Skipped | Failed | Findings | Tokens in / out / cached |', '|---|---|---|---|---|---|---|',
    ...(rows.length > 0 ? rows : ['| none | 0 | 0 | 0 | 0 | none | 0 / 0 / 0 |']), '',
    '### Tool calls', '', '| Tool | Calls |', '|---|---|', ...(tools.length > 0 ? tools : ['| none | 0 |']), '',
  ].join('\n')
}

export function parseReportEnv(env: Record<string, string | undefined>): { token: string; apiBase: string; projectId: number; days: number } {
  if (env.REVIEW_GITLAB_TOKEN === undefined || env.REVIEW_GITLAB_TOKEN === '') throw new Error('missing REVIEW_GITLAB_TOKEN')
  if (env.CI_API_V4_URL === undefined || env.CI_PROJECT_ID === undefined) throw new Error('missing CI_API_V4_URL or CI_PROJECT_ID (run in GitLab CI)')
  const raw = (env.REVIEW_REPORT_DAYS ?? '').trim()
  const days = raw === '' ? 7 : Number(raw)
  if (!/^\d*$/.test(raw) || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`REVIEW_REPORT_DAYS must be 1 to ${MAX_DAYS}, got "${raw}"`)
  return { token: env.REVIEW_GITLAB_TOKEN, apiBase: env.CI_API_V4_URL, projectId: Number(env.CI_PROJECT_ID), days }
}

export async function runReport(
  env: Record<string, string | undefined>,
  deps: { fetcher: typeof fetch; writeFile(path: string, text: string): Promise<void>; log(line: string): void; now?: () => Date },
): Promise<number> {
  try {
    const cfg = parseReportEnv(env)
    const since = new Date((deps.now ?? (() => new Date()))().getTime() - cfg.days * 86_400_000)
    const reports = await discoverReviewReports(deps.fetcher, { apiBase: cfg.apiBase, token: cfg.token, reviewerProjectId: cfg.projectId, since })
    const projectPaths = new Map<number, string>()
    for (const id of new Set(reports.map((r) => r.projectId))) {
      const res = await deps.fetcher(`${cfg.apiBase}/projects/${id}`, { headers: gitlabAuthHeaders(cfg.token) }).catch(() => undefined)
      if (res?.ok) projectPaths.set(id, ((await res.json()) as { path_with_namespace?: string }).path_with_namespace ?? `project/${id}`)
    }
    const report = buildPeriodicReport(reports, { since: since.toISOString(), projectPaths })
    await deps.writeFile('periodic-report.json', `${JSON.stringify(report, null, 2)}\n`)
    const md = renderReportMarkdown(report)
    await deps.writeFile('periodic-report.md', md)
    deps.log(md)
    return 0
  } catch (err) {
    deps.log(`[report] failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
