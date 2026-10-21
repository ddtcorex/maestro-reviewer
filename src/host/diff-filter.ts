import { matchesGlob } from 'node:path'

/**
 * Pre-model diff filter (spec section 6, P3): generated, vendored and lock
 * files never reach the model. The agent tools serve only the kept files;
 * a checkout run can still read a filtered file from the worktree.
 */

export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/composer.lock',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/generated/**',
  'pub/static/**', 'var/**', '**/__snapshots__/**', '**/i18n/*.csv',
]

export interface FilterableDiff { old_path: string; new_path: string; deleted_file?: boolean }

/** A deleted file is matched on its old path, every other file on its new path. Pure. */
export function filterDiffs<T extends FilterableDiff>(diffs: T[], globs: readonly string[]): { kept: T[]; skipped: string[] } {
  const kept: T[] = []
  const skipped: string[] = []
  for (const diff of diffs) {
    const path = diff.deleted_file === true ? diff.old_path : diff.new_path
    if (globs.some((glob) => matchesGlob(path, glob))) skipped.push(path)
    else kept.push(diff)
  }
  return { kept, skipped }
}

/** Defaults, then the repository file's globs, then REVIEW_IGNORE_GLOBS (comma separated). */
export function resolveIgnoreGlobs(env: Record<string, string | undefined>, fileGlobs: readonly string[] = []): string[] {
  const fromEnv = (env.REVIEW_IGNORE_GLOBS ?? '').split(',').map((g) => g.trim()).filter((g) => g !== '')
  return [...DEFAULT_IGNORE_GLOBS, ...fileGlobs, ...fromEnv]
}
