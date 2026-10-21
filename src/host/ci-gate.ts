import { gitlabAuthHeaders } from './forge/gitlab/gitlab-auth.js'
import { severityPrefix } from './severity.js'

/**
 * The opt-in merge gate (REVIEW_GATE=blocking) reads the MR itself: open
 * (unresolved) bot threads whose first note is a blocking finding. The
 * newest review metadata is not trusted for it: a push, a rerun, a narrower
 * rereview or a note forged through an agent would all move that. Resolving
 * a blocking thread is the explicit human override, as with GitLab's own
 * "all threads must be resolved" check.
 */

const BLOCKING = severityPrefix('blocking')
const MAX_PAGES = 20

interface Note { author?: { id?: number }; body?: string; resolvable?: boolean; resolved?: boolean }

export async function openBlockingThreads(
  fetcher: typeof fetch, opts: { baseUrl: string; token: string; projectId: number; mrIid: number; botUserId: number },
): Promise<number> {
  const headers = gitlabAuthHeaders(opts.token)
  let open = 0
  let page = '1'
  for (let i = 0; page !== '' && i < MAX_PAGES; i++) {
    const res = await fetcher(`${opts.baseUrl}/api/v4/projects/${opts.projectId}/merge_requests/${opts.mrIid}/discussions?per_page=100&page=${page}`, { headers })
    if (!res.ok) throw new Error(`GitLab API error ${res.status} reading discussions`)
    const batch = await res.json() as Array<{ notes?: Note[] }>
    for (const d of batch) {
      const first = d.notes?.[0]
      if (first?.author?.id !== opts.botUserId || first.resolvable !== true || first.resolved === true) continue
      // A finding starts with its severity label; a fallback finding starts with its fallback line.
      const body = (first.body ?? '').replace(/^\*\*Inline fallback[^\n]*\*\*\n\n/, '')
      if (body.startsWith(BLOCKING)) open++
    }
    page = batch.length === 0 ? '' : (res.headers.get('x-next-page') ?? '')
  }
  return open
}
