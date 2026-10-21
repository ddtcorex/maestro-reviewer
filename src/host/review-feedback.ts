import { parseCommand } from './commands.js'

/**
 * Feedback loop (spec section 7, F2): a finding code a project keeps
 * dismissing with `/maestro dismiss` is muted for that project. Read from
 * GitLab at review time; a code counts at most once per MR, so repeating a
 * command in one MR never mutes anything.
 */

export const MUTE_THRESHOLD = 3
export const FEEDBACK_WINDOW = 50

const MARKER = /<!-- maestro-finding code=([A-Z][A-Z0-9-]{2,40}) -->/

export function findingCodeMarker(code: string): string {
  return `<!-- maestro-finding code=${code} -->`
}

interface Note { author?: { username?: string }; body?: string; system?: boolean }

/** Pure. The codes dismissed in one MR's discussions; a bare dismiss in a bot thread takes that thread's code. */
export function countDismissals(discussions: Array<{ notes?: Note[] }>, botUsername: string): Set<string> {
  const codes = new Set<string>()
  for (const d of discussions) {
    const notes = d.notes ?? []
    const first = notes[0]
    const threadCode = first?.author?.username === botUsername ? MARKER.exec(first.body ?? '')?.[1] : undefined
    for (const n of notes) {
      if (n.system === true || n.author?.username === botUsername) continue
      const cmd = parseCommand(n.body ?? '')
      if (cmd?.kind !== 'dismiss') continue
      const code = cmd.code ?? threadCode
      if (code !== undefined) codes.add(code)
    }
  }
  return codes
}

/** Pure. Codes dismissed in at least `threshold` MRs. */
export function mutedCodes(stats: Map<string, number>, threshold = MUTE_THRESHOLD): Set<string> {
  return new Set([...stats].filter(([, n]) => n >= threshold).map(([code]) => code))
}
