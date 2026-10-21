import { lstat, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { SECRET_KINDS, redact } from './redact.js'

/**
 * Redacts the files of an ephemeral review checkout in place, so the agents'
 * file tools never read a raw secret. Only ever run on the CI clone under
 * /tmp/maestro-*: anything else is refused. Text files up to `maxBytes`;
 * `.git` and directory symlinks are skipped. A file symlink resolving inside
 * the root, outside `.git`, is left (its target is redacted in place); any
 * other is removed, never copied in: its target (a host `app/etc/env.php`, or
 * `/proc/self/environ` planted by an MR) may hold values no pattern knows.
 * Secrets only: personal data in files the MR does not touch is not the
 * review's to mask (the diff itself is still redacted in full), and masking
 * every email and phone number of a large codebase only fed the model noise.
 */
export async function redactWorktree(root: string, opts: { maxBytes?: number } = {}): Promise<{ files: number; hits: number }> {
  const abs = resolve(root)
  const first = abs.split(sep)[2] ?? ''
  if (!abs.startsWith(`${sep}tmp${sep}`) || !first.startsWith('maestro-')) throw new Error(`refusing to redact outside /tmp/maestro-*: ${abs}`)
  const maxBytes = opts.maxBytes ?? 1_048_576
  const real = await realpath(abs)
  let files = 0
  let hits = 0
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (name === '.git') continue
      const p = join(dir, name)
      const link = (await lstat(p)).isSymbolicLink()
      const st = link ? await stat(p).catch(() => undefined) : await lstat(p)
      if (st === undefined) continue
      if (st.isDirectory()) { if (!link) await walk(p); continue }
      if (link) {
        // Kept only when its target is a file this walk redacts: inside the root, outside .git.
        const target = await realpath(p)
        const inside = target.startsWith(`${real}${sep}`) && !target.slice(real.length + 1).split(sep).includes('.git')
        if (!inside) await unlink(p)
        continue
      }
      if (!st.isFile() || st.size > maxBytes) continue
      const buf = await readFile(p)
      if (buf.subarray(0, 8192).includes(0)) continue
      const r = redact(buf.toString('utf8'), { only: SECRET_KINDS })
      if (r.hits.length === 0) continue
      await writeFile(p, r.text)
      files++
      hits += r.hits.length
    }
  }
  await walk(abs)
  return { files, hits }
}

/**
 * Pure. Whether a DSH host worktree is redacted: always, except when a
 * runtime audit runs (a deep review of the whole MR with the runtime
 * auditor), which needs the real files for tests and the environment.
 */
export function redactsWorkspace(p: { mode: string; scope: { kind: string } }, auditor: 'runtime' | 'static'): boolean {
  return !(p.scope.kind === 'mr' && p.mode === 'deep' && auditor === 'runtime')
}
