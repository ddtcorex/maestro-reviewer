/**
 * `/maestro <command>` notes on a merge request (spec section 7, F2 and F6).
 * A command is the first line of a note, never a quote or a later line, so a
 * summary quoting a command is never read as one.
 */

export type MaestroCommand = { kind: 'dismiss'; code?: string; reason?: string }

const CODE = /^[A-Z][A-Z0-9-]{2,40}$/

/** Pure. Undefined for anything that is not a command on the first line. */
export function parseCommand(noteBody: string): MaestroCommand | undefined {
  const first = noteBody.split('\n')[0].trim()
  const m = /^\/maestro\s+(\w+)(?:\s+(.*))?$/.exec(first)
  if (m === null) return undefined
  const rest = (m[2] ?? '').trim()
  if (m[1] === 'dismiss') {
    const [head, ...tail] = rest.split(/\s+/)
    if (head !== undefined && CODE.test(head)) return { kind: 'dismiss', code: head, ...(tail.length > 0 ? { reason: tail.join(' ') } : {}) }
    return rest === '' ? { kind: 'dismiss' } : { kind: 'dismiss', reason: rest }
  }
  return undefined
}
