import { parseCommand } from './commands.js'
import { normalizeFindingSeverity, severityPrefix } from './severity.js'

/**
 * Feedback loop (spec section 7, F2): a finding code a project keeps
 * dismissing with `/maestro dismiss` is muted for that project. Read from
 * GitLab at review time; a code counts at most once per MR, so repeating a
 * command in one MR never mutes anything.
 */

export const MUTE_THRESHOLD = 3
export const FEEDBACK_WINDOW = 50

const MARKER = /<!-- maestro-finding code=([A-Z][A-Z0-9-]{2,40}) -->/

/** Codes the engine itself raises: the model never sees or answers their threads. */
export const ENGINE_FINDING_CODES: ReadonlySet<string> = new Set(['SEC-SECRET-IN-DIFF', 'MAGENTO-DB-WHITELIST', 'CFG-CHANGED'])

/** Pure. The finding code a note body carries, if any. */
export function findingCodeOf(body: string | undefined): string | undefined {
  return MARKER.exec(body ?? '')?.[1]
}

/**
 * Pure. The dedupe keys of an open bot thread: `<code>@<path>`, plus
 * `<code>@<path>@blocking` when its first note is blocking, so an open major
 * thread never hides a blocking finding of the same code and path.
 */
export function openFindingKeys(code: string, path: string, firstBody: string): string[] {
  return [`${code}@${path}`, ...(firstBody.includes(severityPrefix('blocking')) ? [`${code}@${path}@blocking`] : [])]
}

/** Pure. Whether a deterministic finding already has a matching open thread. */
export function hasOpenThread(f: { code?: string; path?: string; severity?: unknown }, open: ReadonlySet<string>): boolean {
  if (f.code === undefined || f.path === undefined) return false
  return open.has(normalizeFindingSeverity(f.severity) === 'blocking' ? `${f.code}@${f.path}@blocking` : `${f.code}@${f.path}`)
}

export function findingCodeMarker(code: string): string {
  return `<!-- maestro-finding code=${code} -->`
}

interface Note { author?: { username?: string; id?: number }; body?: string; system?: boolean }

const threadCodeOf = (notes: Note[], botUsername: string) =>
  notes[0]?.author?.username === botUsername ? MARKER.exec(notes[0].body ?? '')?.[1] : undefined

/** Pure. The non-bot authors of dismiss commands, by username, for the caller's access check. */
export function dismissalAuthors(discussions: Array<{ notes?: Note[] }>, botUsername: string): Map<string, number> {
  const authors = new Map<string, number>()
  for (const d of discussions) {
    for (const n of d.notes ?? []) {
      const name = n.author?.username
      if (n.system === true || name === undefined || name === botUsername || typeof n.author?.id !== 'number') continue
      if (parseCommand(n.body ?? '')?.kind === 'dismiss') authors.set(name, n.author.id)
    }
  }
  return authors
}

/**
 * Pure. The codes dismissed in one MR's discussions. Only `authorized`
 * authors count (the caller checks Developer access), and only codes the bot
 * raised in that same MR: nobody can dismiss a code that was never shown. A
 * bare dismiss in a bot thread takes that thread's code.
 */
export function countDismissals(discussions: Array<{ notes?: Note[] }>, botUsername: string, authorized: (username: string) => boolean): Set<string> {
  const raised = new Set(discussions.map((d) => threadCodeOf(d.notes ?? [], botUsername)).filter((c): c is string => c !== undefined))
  const codes = new Set<string>()
  for (const d of discussions) {
    const notes = d.notes ?? []
    const threadCode = threadCodeOf(notes, botUsername)
    for (const n of notes) {
      const name = n.author?.username
      if (n.system === true || name === undefined || name === botUsername || !authorized(name)) continue
      const cmd = parseCommand(n.body ?? '')
      if (cmd?.kind !== 'dismiss') continue
      const code = cmd.code ?? threadCode
      if (code !== undefined && raised.has(code)) codes.add(code)
    }
  }
  return codes
}

/** Pure. Codes dismissed in at least `threshold` MRs; security codes (SEC-*) are never muted. */
export function mutedCodes(stats: Map<string, number>, threshold = MUTE_THRESHOLD): Set<string> {
  return new Set([...stats].filter(([code, n]) => n >= threshold && !code.startsWith('SEC-')).map(([code]) => code))
}
