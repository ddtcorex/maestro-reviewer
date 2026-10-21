import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { redact } from './redact.js'

/**
 * Redacts the files of an ephemeral review checkout in place, so the agents'
 * file tools never read a raw secret. Only ever run on the CI clone under
 * /tmp/maestro-*: anything else is refused. Text files up to `maxBytes`;
 * `.git` and symlinks are skipped (a symlink may point outside the root).
 */
export async function redactWorktree(root: string, opts: { maxBytes?: number } = {}): Promise<{ files: number; hits: number }> {
  const abs = resolve(root)
  const first = abs.split(sep)[2] ?? ''
  if (!abs.startsWith(`${sep}tmp${sep}`) || !first.startsWith('maestro-')) throw new Error(`refusing to redact outside /tmp/maestro-*: ${abs}`)
  const maxBytes = opts.maxBytes ?? 1_048_576
  let files = 0
  let hits = 0
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (name === '.git') continue
      const p = join(dir, name)
      const st = await lstat(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { await walk(p); continue }
      if (!st.isFile() || st.size > maxBytes) continue
      const buf = await readFile(p)
      if (buf.subarray(0, 8192).includes(0)) continue
      const r = redact(buf.toString('utf8'))
      if (r.hits.length === 0) continue
      await writeFile(p, r.text)
      files++
      hits += r.hits.length
    }
  }
  await walk(abs)
  return { files, hits }
}
