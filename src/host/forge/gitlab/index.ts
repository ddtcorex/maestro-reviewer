import type { Context } from '@deepseek-ai/cordis'
import type { ReviewForge } from '../types.js'
import { gitlabAuthHeaders } from './gitlab-auth.js'
import * as GitlabClient from './gitlab-client.js'
import { fetchCompare, fetchMrBaseSha, fetchMrDetailHeadSha, postReviewFindings, type GitlabFindingPoster } from './mr-api.js'
import { createReviewSignals } from './review-signals.js'
import { DEFAULT_IGNORE_GLOBS, filterDiffs } from '../../diff-filter.js'

export interface GitlabForgeConfig { baseUrl: string; token: string; botUsername: string }

/** The GitLab forge, bound to one merge request. */
export function gitlabForge(
  cfg: GitlabForgeConfig, mr: { projectId: number; mrIid: number }, opts: { ignoreGlobs?: readonly string[] } = {},
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
      return Promise.resolve({ diffs: kept, skipped, truncated: false })
    }
    diffsLoad ??= GitlabClient.fetchAllDiffs(fetch, mrApi, gitlabAuthHeaders(cfg.token))
      .then((all) => ({ ...filterDiffs(all.diffs, globs), truncated: all.truncated }))
      .then(({ kept, skipped, truncated }) => ({ diffs: kept, skipped, truncated }))
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
    reviewScope: async () => {
      const scope = await loadDiffs()
      return { files: GitlabClient.diffFileList(scope.diffs), skipped: scope.skipped }
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
        ...(toolOpts.onDiffTruncated !== undefined ? { onDiffTruncated: toolOpts.onDiffTruncated } : {}),
      })
    },
  }
}
