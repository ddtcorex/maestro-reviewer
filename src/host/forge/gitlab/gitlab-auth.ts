/**
 * Centralized GitLab API auth header (spec: token-kind aware).
 *
 * Personal / project / group tokens authenticate with `PRIVATE-TOKEN`.
 * A CI job token (`CI_JOB_TOKEN`, cross-project via the target's job-token
 * allowlist) authenticates with `JOB-TOKEN` instead — `PRIVATE-TOKEN` 401s.
 * The kind comes from `GITLAB_TOKEN_KIND=job` (set by docker/entrypoint.sh
 * when it falls back to `CI_JOB_TOKEN`); anything else means PRIVATE-TOKEN.
 */
export function gitlabAuthHeaders(token: string): Record<string, string> {
  if (process.env.GITLAB_TOKEN_KIND === 'job') return { 'JOB-TOKEN': token }
  return { 'PRIVATE-TOKEN': token }
}
