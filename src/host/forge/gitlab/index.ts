import type { Context } from '@deepseek-ai/cordis'
import type { ReviewForge } from '../types.js'
import { gitlabAuthHeaders } from './gitlab-auth.js'
import * as GitlabClient from './gitlab-client.js'
import { fetchRepoFile, fetchCompare, fetchMrBaseSha, fetchMrDetailHeadSha, postReviewFindings, type GitlabFindingPoster } from './mr-api.js'
import { createReviewSignals } from './review-signals.js'
import { DEFAULT_IGNORE_GLOBS, filterDiffs } from '../../diff-filter.js'
import { redactDiff } from '../../redact.js'
import { countDismissals, dismissalAuthors } from '../../review-feedback.js'
import { runWithConcurrency } from '../../chunking.js'

/** Every diff the agents see passes through the redactor; the hits stay with the forge. */
function redactAll(all: GitlabClient.GitlabDiff[], skipped: string[], truncated: boolean, prefix?: string): GitlabClient.ReviewDiffs {
  // Directory boundary: `src` matches src/a.php, never src2/b.php.
  const under = (p: string) => prefix !== undefined && (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`))
  const kept = prefix === undefined ? all : all.filter((d) => under(d.new_path) || under(d.old_path))
  const redacted: NonNullable<GitlabClient.ReviewDiffs['redacted']> = []
  const diffs = kept.map((d) => {
    const r = redactDiff(d.diff)
    if (r.hits.length > 0) redacted.push({ path: d.new_path, hits: r.hits })
    return r.hits.length > 0 ? { ...d, diff: r.diff } : d
  })
  return { diffs, skipped, truncated, redacted }
}

export interface GitlabForgeConfig { baseUrl: string; token: string; botUsername: string }

/** The GitLab forge, bound to one merge request. */
export function gitlabForge(
  cfg: GitlabForgeConfig, mr: { projectId: number; mrIid: number }, opts: { ignoreGlobs?: readonly string[]; pathPrefix?: string } = {},
): ReviewForge {
  const mrApi = `${cfg.baseUrl}/api/v4/projects/${mr.projectId}/merge_requests/${mr.mrIid}`
  const globs = opts.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS
  // One diff load per run, shared by the scope check and every agent's tools;
  // a failed load is not cached.
  let diffsLoad: Promise<GitlabClient.ReviewDiffs> | undefined
  let interdiff: GitlabClient.GitlabDiff[] | undefined
  const loadDiffs = (): Promise<GitlabClient.ReviewDiffs> => {
    if (interdiff !== undefined) {
      const { kept, skipped } = filterDiffs(interdiff, globs)
      return Promise.resolve(redactAll(kept, skipped, false, opts.pathPrefix))
    }
    diffsLoad ??= GitlabClient.fetchAllDiffs(fetch, mrApi, gitlabAuthHeaders(cfg.token))
      .then((all) => ({ ...filterDiffs(all.diffs, globs), truncated: all.truncated }))
      .then(({ kept, skipped, truncated }) => redactAll(kept, skipped, truncated, opts.pathPrefix))
      .catch((err: unknown) => { diffsLoad = undefined; throw err })
    return diffsLoad
  }
  const post = async (url: string, body: string) => {
    const response = await GitlabClient.fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...gitlabAuthHeaders(cfg.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    if (!response.ok) throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
  }
  // One poster per forge: inline positions of a run share one MR diff snapshot.
  const poster: GitlabFindingPoster = { baseUrl: cfg.baseUrl, token: cfg.token, projectId: mr.projectId, mrIid: mr.mrIid }
  return {
    mrHeadSha: () => fetchMrDetailHeadSha(cfg.baseUrl, cfg.token, mr.projectId, mr.mrIid),
    mrBaseSha: () => fetchMrBaseSha(cfg.baseUrl, cfg.token, mr.projectId, mr.mrIid),
    restrictToInterdiff: (files) => { interdiff = files },
    openFindingKeys: async () => {
      const keys = new Set<string>()
      const headers = gitlabAuthHeaders(cfg.token)
      for (let page = 1; page <= 20; page++) {
        const res = await GitlabClient.fetchWithTimeout(`${mrApi}/discussions?per_page=100&page=${page}`, { headers })
        if (!res.ok) break
        const batch = await res.json() as Array<{ notes?: Array<{ author?: { username?: string }; body?: string; resolved?: boolean; position?: { new_path?: string } }> }>
        for (const d of batch) {
          const first = d.notes?.[0]
          const code = /<!-- maestro-finding code=([A-Z][A-Z0-9-]{2,40}) -->/.exec(first?.body ?? '')?.[1]
          if (first?.author?.username === cfg.botUsername && first.resolved !== true && code !== undefined && first.position?.new_path !== undefined) keys.add(`${code}@${first.position.new_path}`)
        }
        if (batch.length < 100) break
      }
      return keys
    },
    readFile: (path, ref) => fetchRepoFile(fetch, { baseUrl: cfg.baseUrl, token: cfg.token, projectId: mr.projectId, ref, path }),
    feedback: async (window) => {
      const headers = gitlabAuthHeaders(cfg.token)
      const projectApi = `${cfg.baseUrl}/api/v4/projects/${mr.projectId}`
      const res = await GitlabClient.fetchWithTimeout(`${projectApi}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=${window}`, { headers })
      if (!res.ok) throw new Error(`GitLab API error ${res.status} listing merge requests`)
      const mrs = (await res.json() as Array<{ iid: number }>).slice(0, window)
      const lists = await runWithConcurrency(mrs.map((m) => async () => {
        const d = await GitlabClient.fetchWithTimeout(`${projectApi}/merge_requests/${m.iid}/discussions?per_page=100`, { headers })
        return d.ok ? await d.json() as Array<{ notes?: [] }> : []
      }), 5)
      const discussions = lists.map((r) => (r.status === 'fulfilled' ? r.value : []))
      // Only Developer or above may mute a code: a Guest or an outside commenter must not silence findings.
      const authors = new Map<string, number>()
      for (const list of discussions) for (const [name, id] of dismissalAuthors(list, cfg.botUsername)) authors.set(name, id)
      const allowed = new Set<string>()
      await runWithConcurrency([...authors].map(([name, id]) => async () => {
        const r = await GitlabClient.fetchWithTimeout(`${projectApi}/members/all/${id}`, { headers })
        if (r.ok && ((await r.json()) as { access_level?: number }).access_level! >= 30) allowed.add(name)
      }), 5)
      const perMr = discussions.map((list) => ({ status: 'fulfilled' as const, value: countDismissals(list, cfg.botUsername, (u) => allowed.has(u)) }))
      const stats = new Map<string, number>()
      for (const r of perMr) if (r.status === 'fulfilled') for (const code of r.value) stats.set(code, (stats.get(code) ?? 0) + 1)
      return stats
    },
    reviewScope: async () => {
      const scope = await loadDiffs()
      return { files: GitlabClient.diffFileList(scope.diffs), skipped: scope.skipped, redacted: scope.redacted ?? [] }
    },
    compare: (from, to) => fetchCompare(cfg.baseUrl, cfg.token, mr.projectId, from, to),
    postNote: (body) => post(`${mrApi}/notes`, body),
    replyToDiscussion: (discussionId, body) => post(`${mrApi}/discussions/${encodeURIComponent(discussionId)}/notes`, body),
    postFindings: (findings) => postReviewFindings(findings, poster),
    signals: () => createReviewSignals({ baseUrl: cfg.baseUrl, token: cfg.token, projectId: mr.projectId, mrIid: mr.mrIid, botUsername: cfg.botUsername }),
    mountAgentTools: async (agentCtx: Context, toolOpts) => {
      await agentCtx.plugin(GitlabClient, {
        baseUrl: cfg.baseUrl,
        projectId: mr.projectId,
        mrIid: mr.mrIid,
        token: cfg.token,
        botUsername: cfg.botUsername,
        loadDiffs,
        ...(toolOpts.onlyPaths !== undefined ? { onlyPaths: toolOpts.onlyPaths } : {}),
        ...(toolOpts.partLabel !== undefined ? { partLabel: toolOpts.partLabel } : {}),
        ...(toolOpts.readOnly === true ? { readOnly: true } : {}),
        ...(toolOpts.onDiffTruncated !== undefined ? { onDiffTruncated: toolOpts.onDiffTruncated } : {}),
      })
    },
  }
}
