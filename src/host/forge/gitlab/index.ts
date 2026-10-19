import type { Context } from '@deepseek-ai/cordis'
import type { ReviewForge } from '../types.js'
import { gitlabAuthHeaders } from './gitlab-auth.js'
import * as GitlabClient from './gitlab-client.js'
import { fetchCompare, fetchMrBaseSha, fetchMrDetailHeadSha, postReviewFindings, type GitlabFindingPoster } from './mr-api.js'
import { createReviewSignals } from './review-signals.js'

export interface GitlabForgeConfig { baseUrl: string; token: string; botUsername: string }

/** The GitLab forge, bound to one merge request. */
export function gitlabForge(cfg: GitlabForgeConfig, mr: { projectId: number; mrIid: number }): ReviewForge {
  const mrApi = `${cfg.baseUrl}/api/v4/projects/${mr.projectId}/merge_requests/${mr.mrIid}`
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
    compare: (from, to) => fetchCompare(cfg.baseUrl, cfg.token, mr.projectId, from, to),
    postNote: (body) => post(`${mrApi}/notes`, body),
    replyToDiscussion: (discussionId, body) => post(`${mrApi}/discussions/${encodeURIComponent(discussionId)}/notes`, body),
    postFindings: (findings) => postReviewFindings(findings, poster),
    signals: () => createReviewSignals({ baseUrl: cfg.baseUrl, token: cfg.token, projectId: mr.projectId, mrIid: mr.mrIid, botUsername: cfg.botUsername }),
    mountAgentTools: async (agentCtx: Context, opts) => {
      await agentCtx.plugin(GitlabClient, {
        baseUrl: cfg.baseUrl,
        projectId: mr.projectId,
        mrIid: mr.mrIid,
        token: cfg.token,
        botUsername: cfg.botUsername,
        ...(opts.onDiffTruncated !== undefined ? { onDiffTruncated: opts.onDiffTruncated } : {}),
      })
    },
  }
}
