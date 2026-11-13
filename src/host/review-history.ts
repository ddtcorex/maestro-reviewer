import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReviewMode, ReviewRequest } from './events.js'

export interface ReviewHistoryEntry {
  id: string
  projectId: number
  projectPath: string
  mrIid: number
  mode: ReviewMode
  scope: 'mr' | 'discussion'
  trigger: ReviewRequest['trigger']
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  finishedAt?: number
  summary?: string
  error?: string
  /** MR head_sha at review start — baseline for incremental re-reviews (H6). */
  headSha?: string
}

const HISTORY_CAP = 100
const STALE_RUNNING_MS = 2 * 60 * 60_000 // 2h — host restart can leave running without finish

export function historyPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'maestro-reviewer', 'reviews.json')
}


async function readAll(dshHome?: string): Promise<ReviewHistoryEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(historyPath(dshHome), 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is ReviewHistoryEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as ReviewHistoryEntry).id === 'string')
  } catch {
    // Missing or corrupt store: start from an empty log rather than failing reviews.
    return []
  }
}

async function writeAll(entries: ReviewHistoryEntry[], dshHome?: string): Promise<void> {
  const path = historyPath(dshHome)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(entries, null, 2), { encoding: 'utf-8', mode: 0o600 })
  await chmod(path, 0o600)
}

function failStaleRunning(entries: ReviewHistoryEntry[]): boolean {
  let mutated = false
  const now = Date.now()
  for (const e of entries) {
    if (e.status === 'running' && now - e.startedAt > STALE_RUNNING_MS) {
      e.status = 'failed'
      e.error = e.error ?? 'auto-failed: stale running review (host restart or crash)'
      e.finishedAt = e.finishedAt ?? now
      mutated = true
    }
  }
  return mutated
}

/** Prepend a running entry; the oldest entries fall off past `HISTORY_CAP`. */
export async function recordReviewStart(entry: Omit<ReviewHistoryEntry, 'status'>, dshHome?: string): Promise<void> {
  return withHistoryLock(async () => {
    const all = await readAll(dshHome)
    if (failStaleRunning(all)) await writeAll(all, dshHome)
    all.unshift({ ...entry, status: 'running' })
    await writeAll(all.slice(0, HISTORY_CAP), dshHome)
  })
}

/** Attach an outcome to the entry with this id; unknown ids are ignored. */
export async function recordReviewFinish(
  id: string,
  patch: { status: 'completed' | 'failed'; summary?: string; error?: string },
  dshHome?: string,
): Promise<void> {
  return withHistoryLock(async () => {
    const all = await readAll(dshHome)
    const entry = all.find((candidate) => candidate.id === id)
    if (entry === undefined) return
    Object.assign(entry, patch, { finishedAt: Date.now() })
    await writeAll(all, dshHome)
  })
}

/** Newest-first slice of the log. */
export async function listReviews(limit = 20, dshHome?: string): Promise<ReviewHistoryEntry[]> {
  return (await readAll(dshHome)).slice(0, limit)
}

/** Whether any review of this MR ever completed — gates push re-reviews. */
export async function hasCompletedReview(projectId: number, mrIid: number, dshHome?: string): Promise<boolean> {
  return (await readAll(dshHome)).some(entry =>
    entry.projectId === projectId && entry.mrIid === mrIid && entry.status === 'completed')
}

/** Newest completed entry for this MR — carries headSha for H6 incrementality. */
export async function lastCompletedReview(projectId: number, mrIid: number, dshHome?: string): Promise<ReviewHistoryEntry | undefined> {
  return (await readAll(dshHome)).find(entry =>
    entry.projectId === projectId && entry.mrIid === mrIid && entry.status === 'completed' && typeof entry.headSha === 'string')
}

/**
 * Drop history entries and failed-report files older than `retentionDays`.
 * `0` disables pruning entirely. Maestro records only — DSH session
 * transcripts are never touched. Entries still `running` are always kept:
 * a prune must never delete a review that just started (see D3).
 */
export async function pruneHistory(retentionDays: number, dshHome?: string): Promise<void> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return
  return withHistoryLock(async () => {
    const all = await readAll(dshHome)
    failStaleRunning(all)
    const cutoff = Date.now() - retentionDays * DAY_MS
    const kept: ReviewHistoryEntry[] = []
    for (const entry of all) {
      if (entry.status === 'running') {
        kept.push(entry)
        continue
      }
      if ((entry.finishedAt ?? entry.startedAt) < cutoff) continue
      kept.push(entry)
    }
    await writeAll(kept, dshHome)
  }).then(async () => {
    const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const failedDir = join(home, 'maestro', 'failed-reports')
    const cutoff = Date.now() - retentionDays * DAY_MS
    let names: string[]
    try {
      names = await readdir(failedDir)
    } catch {
      return
    }
    await Promise.all(names.map(async (name) => {
      // Failed reports are named `<mrIid>-<epoch-ms>.md`.
      const match = /^-?\d+-(\d{13,})\.md$/.exec(name)
      if (match === null) return
      const stamp = Number(match[1])
      if (!Number.isFinite(stamp) || stamp >= cutoff) return
      await rm(join(failedDir, name), { force: true }).catch(() => {})
    }))
  })
}

/**
 * In-process promise-chain mutex serializing the read-modify-write cycles of
 * `recordReviewStart` / `recordReviewFinish` / `pruneHistory`, so a
 * fire-and-forget `void pruneHistory()` can no longer clobber an entry that
 * started concurrently (last-writer-wins on a stale read). Two `dsh web`
 * processes sharing one `DSH_HOME` is unsupported, so a cross-process file
 * lock is deliberately out of scope.
 */
let historyMutex: Promise<void> = Promise.resolve()
function withHistoryLock<T>(work: () => Promise<T>): Promise<T> {
  const next = historyMutex.then(work, work)
  historyMutex = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

const DAY_MS = 24 * 60 * 60_000
