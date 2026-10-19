import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitlabAuthHeaders } from './forge/gitlab/gitlab-auth.js'

/**
 * Source checkout for CI deep reviews (spec §3): clone the source project at
 * the MR head SHA with the PAT over oauth2. The token lives only in the clone
 * URL passed to git — errors rethrown here are redacted, and the clone dir is
 * ephemeral (fresh container per job; the orchestrator removes it in `finally`).
 */

export type RunFn = (cmd: string, args: string[], cwd?: string) => Promise<void>

const execFileAsync = promisify(execFile)

/** Production runner (execFile — no shell, argv cannot leak into shell history). */
export const defaultRun: RunFn = async (cmd, args, cwd) => {
  await execFileAsync(cmd, args, { cwd, timeout: 120_000 })
}

export function redactCloneUrl(url: string): string {
  return url.replace(/oauth2:[^@]+@/, 'oauth2:***@')
}

async function repoHttpUrl(fetcher: typeof fetch, host: string, projectId: number, token: string): Promise<string> {
  const res = await fetcher(`https://${host}/api/v4/projects/${projectId}`, { headers: gitlabAuthHeaders(token) })
  if (!res.ok) throw new Error(`GitLab API error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { http_url_to_repo?: string }
  if (!body.http_url_to_repo) throw new Error('project has no http_url_to_repo')
  return body.http_url_to_repo
}

export async function cloneSourceRepo(opts: {
  fetcher: typeof fetch
  run: RunFn
  host: string
  projectId: number
  sourceBranch: string
  headSha: string
  token: string
  dir: string
  /** MR merge base (diff_refs.base_sha); when set, made reachable from the head. */
  baseSha?: string
}): Promise<string> {
  const httpUrl = await repoHttpUrl(opts.fetcher, opts.host, opts.projectId, opts.token)
  const authed = httpUrl.replace('https://', `https://oauth2:${opts.token}@`)
  try {
    await opts.run('git', ['clone', '--depth', '50', '--branch', opts.sourceBranch, '--', authed, opts.dir])
    await opts.run('git', ['fetch', '--depth', '50', 'origin', opts.headSha], opts.dir)
    await opts.run('git', ['checkout', '--detach', opts.headSha], opts.dir)
    if (opts.baseSha !== undefined) await ensureBaseReachable(opts.run, opts.dir, opts.baseSha, opts.headSha)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(redactCloneUrl(message))
  }
  return opts.dir
}

const DEEPEN_STEP = 200
const DEEPEN_ROUNDS = 10

/**
 * D3: a 50-commit shallow clone may not contain the merge base of a long-lived
 * branch, and any `base...head` diff then fails. Deepen the head history until
 * the base is an ancestor (bounded), else fetch the base object alone so a
 * two-dot diff still works. Nothing in the CI flow strictly needs the base,
 * so a failed last resort only warns: losing the base must never cost the
 * whole review.
 */
async function ensureBaseReachable(run: RunFn, dir: string, baseSha: string, headSha: string): Promise<void> {
  const reachable = async () => run('git', ['merge-base', '--is-ancestor', baseSha, headSha], dir).then(() => true, () => false)
  if (await reachable()) return
  for (let i = 0; i < DEEPEN_ROUNDS; i++) {
    await run('git', ['fetch', `--deepen=${DEEPEN_STEP}`, 'origin', headSha], dir).catch(() => {})
    if (await reachable()) return
  }
  await run('git', ['fetch', '--depth', '1', 'origin', baseSha], dir).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[review] merge base ${baseSha} is not reachable from ${headSha}, continuing without it: ${redactCloneUrl(message)}`)
  })
}
