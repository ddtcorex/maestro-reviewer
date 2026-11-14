import { normalize as posixNormalize } from 'node:path/posix'
import type { ReviewFinding } from '../../review-findings-tool.js'
import { SEVERITY_ORDER, normalizeFindingSeverity, severityPrefix } from '../../severity.js'
import { findingCodeMarker } from '../../review-feedback.js'
import { NOTE_MARKER } from '../../reviewer-note.js'
import { sanitizeAgentText } from './gitlab-client.js'
import type { CompareResult, MrVersion } from '../types.js'
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
 * Merge request versions (head sha and creation time), first page of 100,
 * newest first as GitLab returns them; undefined on any error.
 */
export async function fetchMrVersions(
  baseUrl: string, token: string, projectId: number, mrIid: number, fetcher: typeof fetch = fetch,
): Promise<MrVersion[] | undefined> {
  try {
    const response = await fetcher(`${baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/versions?per_page=100`, { headers: gitlabAuthHeaders(token) })
    if (!response.ok) return undefined
    const versions = await response.json() as Array<{ head_commit_sha?: string; created_at?: string; patch_id_sha?: string }>
    return versions.flatMap((v) => (typeof v.head_commit_sha === 'string' && typeof v.created_at === 'string' ? [{ headSha: v.head_commit_sha, createdAt: v.created_at, ...(typeof v.patch_id_sha === 'string' && v.patch_id_sha !== '' ? { patchIdSha: v.patch_id_sha } : {}) }] : []))
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
  new_file?: boolean
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
/** The note text of a finding: severity (and code, visible and as a hidden marker for `/maestro dismiss`). */
/** Last line number on the new side of a diff; for an added file, that is the file's length. */
function lastNewLine(diff: string): number {
  let last = 0
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) last = Math.max(last, Number(m[1]) + Number(m[2] ?? '1') - 1)
  return last
}

const SEVERITY_LABELS = SEVERITY_ORDER.map((s) => severityPrefix(s))
const SEVERITY_WORDS = SEVERITY_LABELS.map((l) => l.split(' ')[1])
// A separator belongs to the echo only on its line and before a space: `- item` on
// the next line is a list, `-1` is a number.
const ECHO_SEPARATOR = /^(?:·|-|\u2014)(?:[ \t]+|$|(?=\n))/
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The model often restates the header it sees on earlier threads at the start
 * of its body: the label with or without its emoji, a `·`, this finding's
 * code, sometimes wrapped in bold or led by a question mark, then a separator.
 * Removes that prefix and nothing else: a bare severity word, bold text or a
 * question mark is removed only when it is part of such a header. A body that
 * is nothing but an echo is returned as it was.
 */
export function stripHeaderEcho(body: string, code: string | undefined): string {
  const codeToken = code === undefined ? undefined : `\`${code}\``
  // What may follow a stripped bold or question mark: a label, a severity word that a `·` follows, or the code.
  const wordThenDot = `(?:${SEVERITY_WORDS.join('|')})\\s*(?:\\*\\*)?\\s*·`
  const headerAhead = `(?:${[...SEVERITY_LABELS, ...(codeToken !== undefined ? [codeToken] : [])].map(escapeRe).join('|')}|${wordThenDot})`
  const tokens: RegExp[] = [
    ...SEVERITY_LABELS.map((l) => new RegExp(`^${escapeRe(l)}`)),
    // A severity word in any case a `·` follows, with its closing bold when the word was bold (`**Major** ·`).
    new RegExp(`^(?:${SEVERITY_WORDS.join('|')})(?:\\s*\\*\\*)?(?=\\s*·)`, 'i'),
    /^·/,
    // A closing bold belongs to the echo only when it sits right after the code.
    ...(codeToken !== undefined ? [new RegExp(`^${escapeRe(codeToken)}(?:\\*\\*)?`)] : []),
    // Any one-word tag the model put before the code (`question · \`CODE\``), only when this finding's code follows.
    ...(codeToken !== undefined ? [new RegExp(`^\\p{L}+\\s*·(?=\\s*${escapeRe(codeToken)})`, 'u')] : []),
    // Any leading symbol (an emoji the model picked) in front of a severity word and a `·`.
    new RegExp(`^[^\\p{L}\\p{N}\\s\\x60*]{1,4}(?=\\s*(?:\\*\\*)?\\s*(?:${SEVERITY_WORDS.join('|')})\\s*(?:\\*\\*)?\\s*·)`, 'iu'),
    new RegExp(`^❓(?=\\s*(?:\\*\\*)?\\s*${headerAhead})`),
    new RegExp(`^\\*\\*(?=\\s*${headerAhead})`),
  ]
  let rest = body.replace(/^\s+/, '')
  let echoed = false
  let gap = ''
  for (;;) {
    const hit = tokens.map((t) => t.exec(rest)).find((m) => m !== null)
    if (hit === undefined || hit === null) break
    rest = rest.slice(hit[0].length)
    gap = /^\s*/.exec(rest)![0]
    rest = rest.slice(gap.length)
    echoed = true
  }
  if (!echoed) return body
  if (!gap.includes('\n')) rest = rest.replace(ECHO_SEPARATOR, '').replace(/^\s+/, '')
  return rest === '' ? body : rest
}

/**
 * A reply in a thread whose severity is known shows a label only when it
 * differs from the thread's (`🔵 Minor (was 🟡 Major)`); otherwise the code alone.
 */
function noteHeader(finding: ReviewFinding): string {
  const code = finding.code === undefined ? undefined : `\`${finding.code}\``
  const label = severityPrefix(finding.severity)
  if (finding.status === 'reply' && finding.threadSeverity !== undefined) {
    if (normalizeFindingSeverity(finding.severity) === finding.threadSeverity) return code ?? ''
    const changed = `${label} (was ${severityPrefix(finding.threadSeverity)})`
    return code === undefined ? changed : `${changed} · ${code}`
  }
  return code === undefined ? label : `${label} · ${code}`
}

export function findingNoteBody(finding: ReviewFinding): string {
  const head = noteHeader(finding)
  const stripped = stripHeaderEcho(finding.body, finding.code)
  const text = sanitizeAgentText(finding.severityNote === undefined ? stripped : `${finding.severityNote}\n\n${stripped}`)
  return `${head === '' ? '' : `${head}\n\n`}${text}\n\n${finding.code === undefined ? NOTE_MARKER : findingCodeMarker(finding.code)}`
}

export async function postReviewFindings(findings: ReviewFinding[], config: GitlabFindingPoster): Promise<void> {
  const fetcher = config.fetcher ?? fetch
  const apiBase = `${config.baseUrl}/api/v4/projects/${config.projectId}/merge_requests/${config.mrIid}`
  const headers = { ...gitlabAuthHeaders(config.token), 'Content-Type': 'application/json' }
  for (const finding of findings) {
    let response: Response
    const body = findingNoteBody(finding)
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
      if (change === undefined) {
        // A finding on a file the MR did not touch (an incomplete fix, a broken caller)
        // still reaches the author as a top-level note; a path missing at head is a
        // model error and stays a failure.
        const exists = await fetchRepoFile(fetcher, {
          baseUrl: config.baseUrl, token: config.token, projectId: config.projectId,
          ref: snapshot.diffRefs.head_sha, path: requestedPath,
        })
        if (exists === undefined) throw new Error(`cannot post finding at ${finding.path}:${finding.line}: file does not exist at the MR head`)
        response = await fetcher(`${apiBase}/discussions`, {
          method: 'POST', headers,
          body: JSON.stringify({ body: `**Inline fallback — \`${requestedPath}:${finding.line}\` is outside the files this MR changes**\n\n${body}` }),
        })
        if (!response.ok) throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
        continue
      }
      if (change.collapsed === true || change.too_large === true || change.diff === '') {
        throw new Error(`cannot post inline finding at ${finding.path}:${finding.line}: GitLab did not return this file's complete diff`)
      }
      // A deleted file has no "new" side to attach an inline comment to — post as a
      // top-level note instead of relying on diffPositionForNewLine() incidentally
      // returning undefined (true today since a full deletion has no +/context rows,
      // but that's a byproduct of diff-hunk mechanics, not a designed guard).
      if (change.deleted_file === true) {
        response = await fetcher(`${apiBase}/discussions`, {
          method: 'POST', headers,
          body: JSON.stringify({ body: `**Inline fallback — \`${finding.path}:${finding.line}\` was deleted in this MR (no line to attach a comment to)**\n\n${body}` }),
        })
        if (!response.ok) throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
        continue
      }
      const linePosition = diffPositionForNewLine(change.diff, finding.line)
      if (linePosition === undefined) {
        // Line not in diff — fallback to MR note so finding is not silently lost.
        // An added file is whole in its diff, so a line past its end does not exist.
        const length = change.new_file === true ? lastNewLine(change.diff) : 0
        const where = length > 0 && finding.line > length
          ? `is past the end of the file (${length} lines)`
          : 'line is not in current MR diff'
        response = await fetcher(`${apiBase}/discussions`, {
          method: 'POST', headers,
          body: JSON.stringify({ body: `**Inline fallback — \`${finding.path}:${finding.line}\` ${where}**\n\n${body}` }),
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

/** A file's text at `ref`, undefined when it does not exist there; throws on any other answer. */
export async function fetchRepoFile(
  fetcher: typeof fetch, opts: { baseUrl: string; token: string; projectId: number; ref: string; path: string },
): Promise<string | undefined> {
  const res = await fetcher(
    `${opts.baseUrl}/api/v4/projects/${opts.projectId}/repository/files/${encodeURIComponent(opts.path)}/raw?ref=${encodeURIComponent(opts.ref)}`,
    { headers: gitlabAuthHeaders(opts.token) },
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`GitLab API error ${res.status} reading ${opts.path}`)
  return await res.text()
}
