/**
 * MR award-emoji acknowledgements: the MR shows "eyes" while a review runs and
 * a final marker when it completes or fails. Signalling is best-effort — any
 * GitLab error is swallowed so it can never fail the review itself.
 */

import { gitlabAuthHeaders } from './gitlab-auth.js'
import { fetchWithTimeout } from './gitlab-client.js'

export interface ReviewSignals {
  start(): Promise<void>
  finish(outcome: 'completed' | 'failed'): Promise<void>
}

async function award(baseUrl: string, token: string, projectId: number, mrIid: number, name: string): Promise<void> {
  const response = await fetchWithTimeout(`${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/award_emoji`, {
    method: 'POST',
    headers: { ...gitlabAuthHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  // fetchWithTimeout only throws on a network/abort failure; a non-2xx status
  // (expired token, missing scope, rate-limited) resolves normally and must
  // be checked explicitly, or the caller's failure logging never fires.
  if (!response.ok) throw new Error(`GitLab API error ${response.status} awarding "${name}": ${await response.text()}`)
}

/** Every marker name this bot ever awards — kept in one place so `unawardOwn` can always clear all of them, leaving at most one visible at a time. */
const MARKER_NAMES = ['eyes', 'white_check_mark', 'warning'] as const

/**
 * Remove this bot's own markers among `names`; other users' awards stay untouched.
 * Callers pass `MARKER_NAMES` (not just "eyes") so a stale terminal marker from a
 * prior run (e.g. `white_check_mark`) is cleared before re-awarding the same name —
 * GitLab rejects a duplicate award of the same name by the same user with a 404
 * ("Award Emoji Name has already been taken"), which otherwise surfaces as a
 * confusing failure on the second consecutive completed/failed review of one MR.
 */
async function unawardOwn(baseUrl: string, token: string, projectId: number, mrIid: number, botUsername: string, names: readonly string[]): Promise<void> {
  const response = await fetchWithTimeout(`${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/award_emoji`, {
    headers: gitlabAuthHeaders(token),
  })
  if (!response.ok) throw new Error(`GitLab API error ${response.status} listing award emoji: ${await response.text()}`)
  const awards = (await response.json()) as Array<{ id?: number; name?: string; user?: { username?: string } }>
  for (const awardItem of Array.isArray(awards) ? awards : []) {
    if (awardItem.name === undefined || !names.includes(awardItem.name) || awardItem.user?.username !== botUsername || typeof awardItem.id !== 'number') continue
    const deleteResponse = await fetchWithTimeout(`${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/award_emoji/${awardItem.id}`, {
      method: 'DELETE',
      headers: gitlabAuthHeaders(token),
    }).catch((err: unknown) => {
      console.error(`review-signals: failed to delete stale ${awardItem.name} marker ${awardItem.id} on MR !${mrIid}`, err)
      return undefined
    })
    if (deleteResponse !== undefined && !deleteResponse.ok) {
      console.error(`review-signals: GitLab API error ${deleteResponse.status} deleting stale ${awardItem.name} marker ${awardItem.id} on MR !${mrIid}`)
    }
  }
}

export function createReviewSignals(options: { baseUrl: string; token: string; projectId: number; mrIid: number; botUsername: string }): ReviewSignals {
  const { baseUrl, token, projectId, mrIid, botUsername } = options
  return {
    async start() {
      try {
        await unawardOwn(baseUrl, token, projectId, mrIid, botUsername, MARKER_NAMES)
        await award(baseUrl, token, projectId, mrIid, 'eyes')
      } catch (err) {
        // Signalling must never break the review, but a swallowed failure
        // here is exactly what leaves a stale "eyes" marker stuck on the MR
        // forever (blocking the push-gate's 👀-running check for both the
        // webhook and CI flows) with zero trace of why — log it.
        console.error(`review-signals: failed to set the running marker on MR !${mrIid}`, err)
      }
    },
    async finish(outcome) {
      try {
        await unawardOwn(baseUrl, token, projectId, mrIid, botUsername, MARKER_NAMES)
        await award(baseUrl, token, projectId, mrIid, outcome === 'completed' ? 'white_check_mark' : 'warning')
      } catch (err) {
        console.error(`review-signals: failed to clear the running marker / award the final marker on MR !${mrIid}`, err)
      }
    },
  }
}
