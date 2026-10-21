import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The runtime surface @ddtcorex/dsh-maestro-review imports from this package
 * through `@ddtcorex/maestro-reviewer/lib/...`. A refactor that renames or
 * moves one of these breaks the host plugin at boot, so the list is pinned
 * here; change it only together with the plugin. Type-only imports (events,
 * skills-tool, the engine types) are erased and checked by the plugin's tsc.
 */
const PLUGIN_SURFACE: Record<string, string[]> = {
  'lib/engine.js': ['DEDUPED_SUMMARY', 'removeWorktree', 'writeFailedReport', 'createReviewEngine', 'toModelSelection'],
  'lib/engine-row.js': ['apply', 'name', 'inject'],
  'lib/forge/gitlab/index.js': ['gitlabForge'],
  'lib/govard-lint-detection.js': ['govardOnPath'],
  'lib/orchestrator.js': ['assertSafeBranchName', 'declineUnmappedDeepReview', 'isBranchNotFoundError'],
  'lib/review-history.js': ['hasCompletedReview', 'pruneHistory', 'recordReviewFinish', 'recordReviewStart', 'listReviews'],
  'lib/ci-commands.js': ['answerCommands', 'findPendingCommands', 'replyToCommand', 'commandMarker'],
  'lib/ci-repo-settings.js': ['loadRepoSettings'],
  'lib/repo-config.js': ['effectiveConfig'],
  'lib/forge/gitlab/gitlab-client.js': ['timedFetcher'],
  'lib/events.js': [],
  'lib/skills-tool.js': [],
}

describe('engine exports used by dsh-maestro-review', () => {
  it('reaches lib/ through the package exports map', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { exports: Record<string, unknown> }
    expect(pkg.exports['./lib/*']).toBe('./lib/*')
  })

  it.each(Object.entries(PLUGIN_SURFACE))('%s exists after build and exports what the plugin uses', async (path, names) => {
    expect(existsSync(path), `${path} (run pnpm build)`).toBe(true)
    expect(existsSync(path.replace(/\.js$/, '.d.ts')), `${path} types`).toBe(true)
    const mod = await import(`../${path}`) as Record<string, unknown>
    for (const name of names) expect(mod[name], `${path} ${name}`).toBeDefined()
  })
})
