import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gitlabAuthHeaders } from './gitlab-auth.js'

export const name = 'maestro-gitlab-client'
export const inject = ['tools']

export interface Config {
  baseUrl: string
  projectId: string | number
  mrIid: number
  token: string
  botUsername: string
  /** Called once when the MR diff exceeds MAX_DIFF_FILES and was cut. */
  onDiffTruncated?: () => void
  /** The forge's shared, already filtered diff load; absent = fetch every file here. */
  loadDiffs?: () => Promise<ReviewDiffs>
}

/** The MR diffs a review may see, and the paths the ignore globs removed. */
export interface ReviewDiffs { diffs: GitlabDiff[]; skipped: string[]; truncated: boolean }

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  projectId: z.union([z.string(), z.number()]).required(),
  mrIid: z.number().required(),
  token: z.string().role('secret').required(),
  botUsername: z.string().required(),
  onDiffTruncated: z.function(),
  loadDiffs: z.function(),
})

/** Hard cap on diff files fetched for one review. */
export const MAX_DIFF_FILES = 3000

/**
 * All MR diffs. `GET .../diffs` is paginated (default 20 per page), so a
 * single call reviewed only the first page of a larger MR without notice.
 * Follows `x-next-page`; stops on an empty page for servers that send no
 * pagination headers; cuts at MAX_DIFF_FILES and says so.
 */
export async function fetchAllDiffs(
  fetcher: typeof fetch, apiBase: string, headers: Record<string, string>,
): Promise<{ diffs: GitlabDiff[]; truncated: boolean }> {
  const diffs: GitlabDiff[] = []
  let page = 1
  for (;;) {
    const response = await fetcher(`${apiBase}/diffs?per_page=100&page=${page}`, { headers })
    if (!response.ok) throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
    const batch = (await response.json()) as GitlabDiff[]
    if (batch.length === 0) break
    diffs.push(...batch)
    if (diffs.length >= MAX_DIFF_FILES) return { diffs: diffs.slice(0, MAX_DIFF_FILES), truncated: true }
    const next = response.headers.get('x-next-page')
    if (next !== null && next.trim() === '') break
    page = next !== null ? Number(next) : page + 1
  }
  return { diffs, truncated: false }
}

export function diffToolText(value: { path: string; bytes: number; files: unknown[] }, truncated: boolean): string {
  return `diff written to ${value.path} (${value.bytes} bytes, ${value.files.length} files)${truncated ? `; truncated at ${MAX_DIFF_FILES} files, larger MRs are not fully reviewed` : ''}`
}

export interface GitlabDiff {
  old_path: string
  new_path: string
  diff: string
  deleted_file?: boolean
}

export interface DiffFileEntry {
  path: string
  bytes: number
}

/** Per-file inventory of the MR diff — small enough to return inline. Pure. */
export function diffFileList(diffs: GitlabDiff[]): DiffFileEntry[] {
  return diffs.map((d) => ({ path: d.new_path, bytes: Buffer.byteLength(d.diff, 'utf8') }))
}

/** Unified text for one file, or undefined when the path is not in the MR. Pure. */
export function selectFileDiff(diffs: GitlabDiff[], path: string): string | undefined {
  const d = diffs.find((x) => x.new_path === path || x.old_path === path)
  if (d === undefined) return undefined
  return `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`
}

/**
 * `fetch` with a hard ceiling: aborts the request after `ms` (default 15s)
 * and throws `GitLab API timeout after <ms>ms` on abort. The timer is always
 * cleared on settle. Pre-agent lookups degrade the throw to `undefined` at
 * their own call site; post-agent callers let it reach `writeFailedReport`.
 */
export async function fetchWithTimeout(
  url: string, init: RequestInit | undefined, ms = 15_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error(`GitLab API timeout after ${ms}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

interface GitlabDiffRefs {
  base_sha: string
  start_sha: string
  head_sha: string
}

interface GitlabDiscussionNote {
  body: string
  author: { username: string }
  position?: { new_path: string, new_line: number | null }
  resolved: boolean
}

interface GitlabDiscussion {
  id: string
  notes: GitlabDiscussionNote[]
}

interface OwnThread {
  discussionId: string
  path: string
  line: number | null
  lastCommentBody: string
  resolved: boolean
}

/**
 * Resolve the in-workspace spill path for the MR diff. The DSH runtime
 * spills large tool outputs to /tmp/dsh-spill-*, which sits outside the
 * agent's cwd — and Guard blocks the agent from reading it back
 * ("path outside cwd", tickets g-dd0d1679/g-716cd436). Writing the diff
 * inside the workspace root keeps it readable via the read tool.
 */
export function resolveDiffSpillPath(workspaceRoot: string, mrIid: number): string {
  return join(resolve(workspaceRoot), '.maestro', `mr-${mrIid}.diff`)
}

export function writeDiffSpill(workspaceRoot: string, mrIid: number, text: string): { path: string; bytes: number } {
  const abs = resolveDiffSpillPath(workspaceRoot, mrIid)
  mkdirSync(join(resolve(workspaceRoot), '.maestro'), { recursive: true })
  writeFileSync(abs, text, 'utf-8')
  return { path: join('.maestro', `mr-${mrIid}.diff`), bytes: Buffer.byteLength(text, 'utf8') }
}

interface SC{agent?:{session?:{header?:{cwd?:string}}}}
function sessionCwd(e: unknown): string | undefined {
  const cwd = (e as SC|undefined)?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Pick this bot's inline threads out of the MR discussions list, including
 * resolved ones (flagged) so a same-SHA re-review can reply-update instead
 * of posting duplicates. Pure for unit testing.
 */
export function selectOwnThreads(
  discussions: GitlabDiscussion[],
  botUsername: string,
): { threads: OwnThread[]; totalDiscussions: number } {
  const threads = discussions
    .filter(d => d.notes.length > 0 && d.notes[0].author.username === botUsername && d.notes[0].position !== undefined)
    .map(d => ({
      discussionId: d.id,
      path: d.notes[0].position!.new_path,
      line: d.notes[0].position!.new_line,
      lastCommentBody: d.notes[d.notes.length - 1].body,
      resolved: d.notes[0].resolved === true,
    }))
  return { threads, totalDiscussions: discussions.length }
}

export function apply(ctx: Context, config: Config): void {
  const apiBase = `${config.baseUrl}/api/v4/projects/${config.projectId}/merge_requests/${config.mrIid}`
  const headers = gitlabAuthHeaders(config.token)
  let cachedDiffRefs: GitlabDiffRefs | undefined
  let cachedDiffs: GitlabDiff[] | undefined

  let diffsTruncated = false
  let skippedPaths: string[] = []
  async function getDiffs(): Promise<GitlabDiff[]> {
    if (cachedDiffs !== undefined) return cachedDiffs
    const all = config.loadDiffs !== undefined ? await config.loadDiffs() : { ...await fetchAllDiffs(fetch, apiBase, headers), skipped: [] }
    cachedDiffs = all.diffs
    skippedPaths = all.skipped
    diffsTruncated = all.truncated
    if (all.truncated) config.onDiffTruncated?.()
    return cachedDiffs
  }

  async function getDiffRefs(): Promise<GitlabDiffRefs> {
    if (cachedDiffRefs !== undefined) return cachedDiffRefs
    const response = await fetch(apiBase, { headers })
    if (!response.ok) {
      throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
    }
    cachedDiffRefs = (await response.json() as { diff_refs: GitlabDiffRefs }).diff_refs
    return cachedDiffRefs
  }

  ctx.tools.register(defineTool({
    name: 'gitlab_get_mr_diff',
    description: 'Fetch the current unified diff for this merge request. The full diff is written to path (inside your workspace, readable with the read tool); bytes is its size and files lists per-file sizes. Prefer gitlab_get_file_diff per file you inspect — small inline results never spill. Do not look for anything under /tmp.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, bytes: { type: 'number', required: true }, files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, bytes: { type: 'number', required: true } } } } } },
      render: (_args, value) => [{ type: 'text', text: diffToolText(value, diffsTruncated) }],
    },
    async execute(_args, exec) {
      const diffs = await getDiffs()
      const text = diffs.map(d => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`).join('\n\n')
      const cwd = sessionCwd(exec)
      // No session cwd (should not happen for review agents): fall back to
      // the legacy inline text, which the runtime may spill to /tmp.
      if (cwd === undefined) return { path: '', bytes: Buffer.byteLength(text, 'utf8'), files: diffFileList(diffs) }
      const spilled = writeDiffSpill(cwd, config.mrIid, text)
      return { ...spilled, files: diffFileList(diffs) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_get_file_diff',
    description: "Return one file's unified diff inline (small results never spill to /tmp). Use after gitlab_get_mr_diff to inspect files one by one.",
    parameters: {
      path: { type: 'string', required: true, description: 'New path of the file, as listed in files.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const diffs = await getDiffs()
      const text = selectFileDiff(diffs, args.path)
      if (text === undefined && skippedPaths.includes(args.path)) {
        throw new Error(`path filtered from this review (generated, vendored or lock file): ${args.path}`)
      }
      if (text === undefined) {
        throw new Error(`path not in this MR diff: ${args.path}`)
      }
      return { path: args.path, text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_post_mr_comment',
    description: 'Post a Markdown comment (discussion note) on this merge request.',
    parameters: {
      body: { type: 'string', required: true, description: 'Markdown comment body.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { posted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'Comment posted.' }],
    },
    async execute(args) {
      const response = await fetch(`${apiBase}/notes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: args.body }),
      })
      if (!response.ok) {
        throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
      }
      return { posted: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_list_own_review_threads',
    description: 'List this merge request\'s inline discussion threads previously created by this bot account (both unresolved and resolved, flagged), so you can reply instead of duplicating. Returns {threads, totalDiscussions}.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threads: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                discussionId: { type: 'string', required: true },
                path: { type: 'string', required: true },
                line: { type: 'number' },
                lastCommentBody: { type: 'string', required: true },
                resolved: { type: 'boolean', required: true },
              },
            },
          },
          totalDiscussions: { type: 'number', required: true },
        },
      },
      render: (_args, value: { threads: OwnThread[]; totalDiscussions: number }) => [{
        type: 'text',
        text: `${value.totalDiscussions} discussion(s) on this MR, ${value.threads.length} own inline thread(s):\n${JSON.stringify(value.threads)}`,
      }],
    },
    async execute() {
      const response = await fetch(`${apiBase}/discussions`, { headers })
      if (!response.ok) {
        throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
      }
      const discussions = await response.json() as GitlabDiscussion[]
      return selectOwnThreads(discussions, config.botUsername)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_post_inline_comment',
    description: 'Create a new inline discussion at a specific file and line in this merge request\'s current diff.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path on the new (target) side of the diff.' },
      line: { type: 'number', required: true, description: 'Line number on the new (target) side of the diff.' },
      body: { type: 'string', required: true, description: 'Markdown comment body.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { posted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'Inline comment posted.' }],
    },
    async execute(args) {
      const diffRefs = await getDiffRefs()
      const response = await fetch(`${apiBase}/discussions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: args.body,
          position: {
            position_type: 'text',
            base_sha: diffRefs.base_sha,
            start_sha: diffRefs.start_sha,
            head_sha: diffRefs.head_sha,
            old_path: args.path,
            new_path: args.path,
            new_line: args.line,
          },
        }),
      })
      if (!response.ok) {
        throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
      }
      return { posted: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gitlab_reply_to_thread',
    description: 'Reply to an existing inline discussion thread (discussionId from gitlab_list_own_review_threads) without resolving it.',
    parameters: {
      discussionId: { type: 'string', required: true },
      body: { type: 'string', required: true, description: 'Markdown reply body.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { posted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'Reply posted.' }],
    },
    async execute(args) {
      const response = await fetch(`${apiBase}/discussions/${args.discussionId}/notes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: args.body }),
      })
      if (!response.ok) {
        throw new Error(`GitLab API error ${response.status}: ${await response.text()}`)
      }
      return { posted: true }
    },
  }))
}
