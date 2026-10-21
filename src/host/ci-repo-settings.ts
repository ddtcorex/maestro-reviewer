import { gitlabAuthHeaders } from './forge/gitlab/gitlab-auth.js'
import { fetchRepoFile } from './forge/gitlab/mr-api.js'
import { REPO_CONFIG_PATH, parseRepoConfig, type RepoReviewConfig } from './repo-config.js'

/**
 * `.maestro-review.yml` from the project's default branch, for the CI trigger
 * and the DSH host alike. Never the MR head or the branch it targets: the
 * author chooses both. Problems become warnings, never a failed review.
 */
export async function loadRepoSettings(
  fetcher: typeof fetch, opts: { baseUrl: string; token: string; projectId: number },
): Promise<{ file: RepoReviewConfig; warnings: string[] }> {
  let ref: string | undefined
  try {
    const res = await fetcher(`${opts.baseUrl}/api/v4/projects/${opts.projectId}`, { headers: gitlabAuthHeaders(opts.token) })
    const body = res.ok ? await res.json() as { default_branch?: unknown } : undefined
    ref = typeof body?.default_branch === 'string' ? body.default_branch : undefined
  } catch {
    ref = undefined
  }
  if (ref === undefined) return { file: {}, warnings: [`${REPO_CONFIG_PATH} not read: the project's default branch is unknown; using the defaults`] }
  try {
    const text = await fetchRepoFile(fetcher, { baseUrl: opts.baseUrl, token: opts.token, projectId: opts.projectId, ref, path: REPO_CONFIG_PATH })
    if (text === undefined) return { file: {}, warnings: [] }
    const parsed = parseRepoConfig(text)
    return { file: parsed.config, warnings: parsed.warnings }
  } catch (err) {
    return { file: {}, warnings: [`${REPO_CONFIG_PATH} could not be read (${err instanceof Error ? err.message : String(err)}); using the defaults`] }
  }
}
