import { normalize as posixNormalize } from 'node:path/posix'
import type { ReviewFinding } from '../../review-findings-tool.js'
import { severityPrefix } from '../../severity.js'
import type { CompareResult } from '../types.js'
import { gitlabAuthHeaders } from './gitlab-auth.js'
import { fetchWithTimeout } from './gitlab-client.js'

/** GitLab REST reads and writes of one merge request, as the review engine needs them. */

/**
 * Cheap head-sha probe: `GET /merge_requests/:iid` returns diff_refs.head_sha
 * without pulling any diff bodies. Degrades to undefined (no incrementality)
 * on any error — re-reviews must never fail because of this optional lookup.
 */
export async function fetchMrDetailHeadSha(
  baseUrl: string, token: string, projectId: number, mrIid: number,
): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}`,
      { headers: gitlabAuthHeaders(token) },
    )
    if (!response.ok) return undefined
    const body = await response.json() as { diff_refs?: { head_sha?: string } }
    return body.diff_refs?.head_sha
  } catch {
    return undefined
  }
}

/** Diff between two MR states, reduced to the fields the prompt block needs. */
export async function fetchCompare(
  baseUrl: string, token: string, projectId: number, from: string, to: string,
): Promise<CompareResult | undefined> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/v4/projects/${projectId}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: gitlabAuthHeaders(token) },
    )
    if (!response.ok) return undefined
    return await response.json() as CompareResult
  } catch {
    return undefined
  }
}

/**
 * Fetch the MR's diff base SHA for govard diff-scope runs. Best-effort:
 * returns undefined (the reviewer prompt then omits the lint rule) rather
 * than failing the review when GitLab is unreachable.
 */
export async function fetchMrBaseSha(
  baseUrl: string,
  token: string,
  projectId: number,
  mrIid: number,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetcher(
      `${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}`,
      { headers: gitlabAuthHeaders(token) },
    )
    if (!response.ok) return undefined
    const mr = await response.json() as { diff_refs?: { base_sha?: string } }
    return mr.diff_refs?.base_sha
  } catch {
    return undefined
  }
}

export interface GitlabFindingPoster {
  baseUrl: string
  token: string
  projectId: number
  mrIid: number
  fetcher?: typeof fetch
  /** Internal per-review cache: all positions must use one MR diff snapshot. */
  snapshot?: Promise<GitlabDiffSnapshot>
}

interface GitlabMrChange {
  old_path: string
  new_path: string
  diff: string
  collapsed?: boolean
  too_large?: boolean
  deleted_file?: boolean
}

interface GitlabDiffPosition {
  oldLine?: number
  newLine?: number
}

interface GitlabDiffSnapshot {
  diffRefs: { base_sha: string; start_sha: string; head_sha: string }
  changes: GitlabMrChange[]
}

/** Map a new-side line number to its exact unified-diff position. */
export function diffPositionForNewLine(diff: string, targetLine: number): GitlabDiffPosition | undefined {
  let oldLine = 0
  let newLine = 0
  for (const row of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (header !== null) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }
    if (row.startsWith('\\')) continue
    if (row.startsWith('+')) {
      if (newLine === targetLine) return { newLine }
      newLine++
      continue
    }
    if (row.startsWith('-')) {
      oldLine++
      continue
    }
    if (row.startsWith(' ')) {
      if (newLine === targetLine) return { oldLine, newLine }
      oldLine++
      newLine++
    }
  }
  return undefined
}

async function loadLatestDiffSnapshot(fetcher: typeof fetch, apiBase: string, headers: Record<string, string>): Promise<GitlabDiffSnapshot> {
  const versionsResponse = await fetcher(`${apiBase}/versions`, { headers })
  if (!versionsResponse.ok) throw new Error(`GitLab API error ${versionsResponse.status}: ${await versionsResponse.text()}`)
  const versions = await versionsResponse.json() as Array<{ id?: number }>
  const latest = versions[0]
  if (latest?.id === undefined) throw new Error('GitLab merge request has no available diff version')
  const versionResponse = await fetcher(`${apiBase}/versions/${latest.id}`, { headers })
  if (!versionResponse.ok) throw new Error(`GitLab API error ${versionResponse.status}: ${await versionResponse.text()}`)
  const version = await versionResponse.json() as {
    base_commit_sha?: string
    start_commit_sha?: string
    head_commit_sha?: string
    diffs?: GitlabMrChange[]
  }
  if (version.base_commit_sha === undefined || version.start_commit_sha === undefined || version.head_commit_sha === undefined) {
    throw new Error('GitLab merge request diff version has incomplete SHA references')
  }
  if (version.diffs === undefined) throw new Error('GitLab merge request diff version has no file diffs')
  return {
    diffRefs: { base_sha: version.base_commit_sha, start_sha: version.start_commit_sha, head_sha: version.head_commit_sha },
    changes: version.diffs,
  }
}

/**
 * Collapse `.`/`..`/duplicate slashes so worktree-relative finding paths
 * (which legitimately contain `../` segments when a template references a
 * sibling theme directory) compare equal to GitLab's canonical diff paths.
 */
function normalizedDiffPath(path: string): string {
  return posixNormalize(path)
}

/**
 * Publish agent findings from the orchestrator's own context. Agent tools are
 * mounted inside a setup child fiber and are not guaranteed to remain
 * executable through `handle.agent.ctx` after the agent turn ends.
 */
export async function postReviewFindings(findings: ReviewFinding[], config: GitlabFindingPoster): Promise<void> {
  const fetcher = config.fetcher ?? fetch
  const apiBase = `${config.baseUrl}/api/v4/projects/${config.projectId}/merge_requests/${config.mrIid}`
  const headers = { ...gitlabAuthHeaders(config.token), 'Content-Type': 'application/json' }
  for (const finding of findings) {
    let response: Response
    const label = severityPrefix(finding.severity)
    const body = finding.body.startsWith(label) ? finding.body : `${label}\n\n${finding.body}`
    if (finding.status === 'reply') {
      if (finding.discussionId === undefined) throw new Error('reply finding missing discussionId')
      response = await fetcher(`${apiBase}/discussions/${encodeURIComponent(finding.discussionId)}/notes`, {
        method: 'POST', headers, body: JSON.stringify({ body }),
      })
    } else {
      if (finding.path === undefined || finding.line === undefined) throw new Error('new finding missing path or line')
      config.snapshot ??= loadLatestDiffSnapshot(fetcher, apiBase, headers)
      const snapshot = await config.snapshot
      const requestedPath = normalizedDiffPath(finding.path)
      const change = snapshot.changes.find(candidate => normalizedDiffPath(candidate.new_path) === requestedPath)
        ?? snapshot.changes.find(candidate => normalizedDiffPath(candidate.old_path) === requestedPath)
      if (change === undefined) throw new Error(`cannot post inline finding at ${finding.path}:${finding.line}: file is not in the current MR diff`)
      if (change.collapsed === true || change.too_large === true || change.diff === '') {
        throw new Error(`cannot post inline finding at ${finding.path}:${finding.line}: GitLab did not return this file's complete diff`)
      }
      // A deleted file has no "new" side to attach an inline comment to — post as a
      // top-level note instead of relying on diffPositionForNewLine() incidentally
      // returning undefined (true today since a full deletion has no +/context rows,
      // but that's a byproduct of diff-hunk mechanics, not a designed guard).
      if (change.deleted_file === true) {
        response = await fetcher(`${apiBase}/notes`, {
          method: 'POST', headers,
          body: JSON.stringify({ body: `**Inline fallback — \`${finding.path}\` was deleted in this MR (no line ${finding.line} to attach a comment to)**\n\n${body}` }),
        })
        if (!response.ok) throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
        continue
      }
      const linePosition = diffPositionForNewLine(change.diff, finding.line)
      if (linePosition === undefined) {
        // Line not in diff — fallback to MR note so finding is not silently lost.
        response = await fetcher(`${apiBase}/notes`, {
          method: 'POST', headers,
          body: JSON.stringify({ body: `**Inline fallback — \`${finding.path}:${finding.line}\` line is not in current MR diff**\n\n${body}` }),
        })
      } else {
        response = await fetcher(`${apiBase}/discussions`, {
          method: 'POST', headers,
          body: JSON.stringify({ body, position: {
            position_type: 'text', ...snapshot.diffRefs, old_path: change.old_path, new_path: change.new_path,
            ...linePosition.oldLine === undefined ? {} : { old_line: linePosition.oldLine },
            ...linePosition.newLine === undefined ? {} : { new_line: linePosition.newLine },
          } }),
        })
      }
    }
    if (!response.ok) throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
  }
}
