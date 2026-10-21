import { splitScope } from './scope-split-tool.js'

/**
 * Size-based fan-out (spec section 6, P4): an MR above the file or byte
 * threshold is reviewed in parts by parallel reviewer agents, each seeing
 * only its own files. High risk parts (PHP, di.xml, plugins, per the
 * scope-split rules) can route to a stronger model.
 */

export interface Chunk { id: string; files: string[]; risk: 'high' | 'low' }
export interface FanoutThresholds { files: number; bytes: number }
export interface FanoutSettings extends FanoutThresholds { concurrency: number }

export const DEFAULT_FANOUT: FanoutSettings = { files: 25, bytes: 150_000, concurrency: 3 }

/** Magento code and themes group by module or theme, everything else by its first two segments. */
export function groupKey(path: string): string {
  const parts = path.split('/')
  if (parts.length === 1) return '.'
  const depth = parts[0] === 'app' && (parts[1] === 'code' || parts[1] === 'design') ? 4 : 2
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/')
}

/** Pure. Under both thresholds the whole MR is one chunk `all`; a single file is never split. */
export function planChunks(files: Array<{ path: string; bytes: number }>, t: FanoutThresholds): Chunk[] {
  const total = files.reduce((n, f) => n + f.bytes, 0)
  if (files.length <= t.files && total <= t.bytes) return [{ id: 'all', files: files.map((f) => f.path), risk: 'low' }]
  const high = new Set(splitScope({ files: files.map((f) => f.path) }, 'deep').split.deep.files)
  const chunks: Chunk[] = []
  for (const risk of ['high', 'low'] as const) {
    const mine = files.filter((f) => high.has(f.path) === (risk === 'high'))
      .sort((a, b) => groupKey(a.path).localeCompare(groupKey(b.path)) || a.path.localeCompare(b.path))
    let current: { files: string[]; bytes: number } | undefined
    for (const file of mine) {
      if (current !== undefined && (current.files.length + 1 > t.files || current.bytes + file.bytes > t.bytes)) current = undefined
      if (current === undefined) {
        current = { files: [], bytes: 0 }
        chunks.push({ id: `${risk}-${chunks.filter((c) => c.risk === risk).length + 1}`, files: current.files, risk })
      }
      current.files.push(file.path)
      current.bytes += file.bytes
    }
  }
  return chunks
}

/** Runs the tasks with at most `limit` in flight; results keep the task order. */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < tasks.length; i = next++) {
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() } } catch (reason) { results[i] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker))
  return results
}
