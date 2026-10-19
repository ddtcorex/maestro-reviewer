import { gitlabAuthHeaders } from './forge/gitlab/gitlab-auth.js'
import { parseReviewMarker, parseReviewMeta, type ReviewMeta } from './review-marker.js'

/**
 * Coexistence checks (spec §4): the CI flow yields to a completed review of
 * the same head SHA carrying a review marker (i.e. an earlier CI review —
 * webhook reviews post marker-free and stay invisible here) and to an
 * in-flight review (eyes running-marker). Only signals left by the token's
 * own user (`botUserId`) count: anyone else's marker or eyes reaction is
 * ignored, so a developer can neither paste a marker nor react with eyes to
 * suppress a review. Fetch failures and an unknown bot identity fail open
 * toward running — a missing signal must never block a review, only a
 * present one skips it.
 */
export async function hasCompletedReviewForSha(
  fetcher: typeof fetch, baseUrl: string, token: string, projectId: number, mrIid: number, sha: string,
  botUserId: number | undefined,
): Promise<boolean> {
  if (botUserId === undefined) return false
  try {
    const res = await fetcher(
      `${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100&sort=desc&order_by=created_at`,
      { headers: gitlabAuthHeaders(token) },
    )
    if (!res.ok) return false
    const notes = (await res.json()) as Array<{ author?: { id?: number }; body?: string }>
    return notes.some((n) => {
      if (n.author?.id !== botUserId) return false
      const m = typeof n.body === 'string' ? parseReviewMarker(n.body) : undefined
      return m?.sha.toLowerCase() === sha.toLowerCase() && m?.status === 'completed'
    })
  } catch {
    return false
  }
}

export async function hasRunningEyes(
  fetcher: typeof fetch, baseUrl: string, token: string, projectId: number, mrIid: number,
  botUserId: number | undefined,
): Promise<boolean> {
  if (botUserId === undefined) return false
  try {
    const res = await fetcher(
      `${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/award_emoji`,
      { headers: gitlabAuthHeaders(token) },
    )
    if (!res.ok) return false
    const awards = (await res.json()) as Array<{ name?: string; user?: { id?: number } }>
    return awards.some((a) => a.name === 'eyes' && a.user?.id === botUserId)
  } catch {
    return false
  }
}

const MAX_NOTE_PAGES = 20

/** The id of the user the token acts as (the bot); throws when GitLab cannot say. */
export async function fetchBotUserId(fetcher: typeof fetch, baseUrl: string, token: string): Promise<number> {
  const me = await fetcher(`${baseUrl}/api/v4/user`, { headers: gitlabAuthHeaders(token) })
  const user = me.ok ? await me.json() as { id?: unknown } : undefined
  if (typeof user?.id !== 'number') throw new Error(`cannot resolve the bot user (GET /user -> ${me.status})`)
  return user.id
}

/**
 * The newest completed review on the MR, read from GitLab (spec §4.1): the
 * first note, newest first, authored by the token's own user that carries
 * valid review metadata. Notes by anyone else are ignored, so a pasted block can
 * never suppress a review. Throws when GitLab cannot be read so the caller
 * can fall back; returns undefined when the MR simply has no bot review.
 */
export async function latestCompletedReview(
  fetcher: typeof fetch,
  opts: { baseUrl: string; token: string; projectId: number; mrIid: number; botUserId?: number },
): Promise<ReviewMeta | undefined> {
  const headers = gitlabAuthHeaders(opts.token)
  const botId = opts.botUserId ?? await fetchBotUserId(fetcher, opts.baseUrl, opts.token)
  let page = '1'
  for (let n = 0; page && n < MAX_NOTE_PAGES; n++) {
    const res = await fetcher(
      `${opts.baseUrl}/api/v4/projects/${opts.projectId}/merge_requests/${opts.mrIid}/notes?sort=desc&order_by=created_at&per_page=100&page=${page}`,
      { headers },
    )
    if (!res.ok) throw new Error(`GitLab notes API error ${res.status}`)
    const notes = await res.json() as Array<{ system?: boolean; author?: { id?: number }; body?: string; created_at?: string }>
    for (const note of notes) {
      if (note.system === true || note.author?.id !== botId || typeof note.body !== 'string') continue
      const meta = parseReviewMeta(note.body)
      if (meta !== undefined) return meta
    }
    page = res.headers.get('x-next-page') ?? ''
  }
  return undefined
}

/**
 * Whether the bot already posted a deep review for this head SHA (metadata
 * mode deep). Read failures answer
 * false: a missing signal never blocks a requested review.
 */
export async function hasCompletedDeepReview(
  fetcher: typeof fetch,
  opts: { baseUrl: string; token: string; projectId: number; mrIid: number; botUserId: number; sha: string },
): Promise<boolean> {
  const headers = gitlabAuthHeaders(opts.token)
  const sha = opts.sha.toLowerCase()
  try {
    let page = '1'
    for (let n = 0; page && n < MAX_NOTE_PAGES; n++) {
      const res = await fetcher(
        `${opts.baseUrl}/api/v4/projects/${opts.projectId}/merge_requests/${opts.mrIid}/notes?sort=desc&order_by=created_at&per_page=100&page=${page}`,
        { headers },
      )
      if (!res.ok) return false
      const notes = await res.json() as Array<{ system?: boolean; author?: { id?: number }; body?: string }>
      for (const note of notes) {
        if (note.system === true || note.author?.id !== opts.botUserId || typeof note.body !== 'string') continue
        const meta = parseReviewMeta(note.body)
        if (meta?.mode === 'deep' && meta.headSha.toLowerCase() === sha) return true
      }
      page = res.headers.get('x-next-page') ?? ''
    }
  } catch {
    return false
  }
  return false
}

/** Removes the deep-review label from the MR (the request was met). */
export async function removeDeepLabel(
  fetcher: typeof fetch,
  opts: { baseUrl: string; token: string; projectId: number; mrIid: number },
): Promise<void> {
  const res = await fetcher(`${opts.baseUrl}/api/v4/projects/${opts.projectId}/merge_requests/${opts.mrIid}`, {
    method: 'PUT',
    headers: { ...gitlabAuthHeaders(opts.token), 'content-type': 'application/json' },
    body: JSON.stringify({ remove_labels: 'maestro-review::deep' }),
  })
  if (!res.ok) throw new Error(`GitLab ${res.status} removing the deep label`)
}
