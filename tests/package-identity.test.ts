import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { historyPath } from '../src/host/review-history.js'
import { runtimeStatePath } from '../src/host/config-store.js'
import { REVIEW_SOURCE_KIND } from '../src/host/source.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(REPO_ROOT, f), 'utf-8')
const pkg = JSON.parse(read('package.json')) as { name: string; repository: { url: string } }

/** Every Cordis `name:` value in a patch document, at any depth. */
function moduleNames(doc: unknown, out: string[] = []): string[] {
  if (Array.isArray(doc)) for (const d of doc) moduleNames(d, out)
  else if (doc !== null && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'name' && typeof v === 'string' && v.startsWith('@ddtcorex/')) out.push(v)
      else moduleNames(v, out)
    }
  }
  return out
}

/** Every `id:` value in a patch document, at any depth. */
function rowIds(doc: unknown, out: string[] = []): string[] {
  if (Array.isArray(doc)) for (const d of doc) rowIds(d, out)
  else if (doc !== null && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'id' && typeof v === 'string') out.push(v)
      else rowIds(v, out)
    }
  }
  return out
}

describe('package identity after the maestro-reviewer rename', () => {
  it('uses the new package name and repository', () => {
    expect(pkg.name).toBe('@ddtcorex/maestro-reviewer')
    expect(pkg.repository.url).toBe('git+https://github.com/ddtcorex/maestro-reviewer.git')
    expect(read('src/host/index.ts')).toMatch(/export const name = '@ddtcorex\/maestro-reviewer'/)
  })

  it('points every shipped Cordis row at the new module path and keeps row ids', () => {
    const files = ['cordis.patch.yml', 'presets/maestro-reviewer.patch.yml', 'presets/maestro-auditor.patch.yml', 'presets/maestro-coder/agent.cordis.yml', 'profiles/reviewer-ci/cordis.patch.yml']
    const docs = files.map(f => parse(read(f)))
    const names = docs.flatMap(d => moduleNames(d))
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n, n).toMatch(/^@ddtcorex\/maestro-reviewer(\/|$)/)
    expect(rowIds(docs[0])).toEqual(expect.arrayContaining([
      'maestro-review-host', 'maestro-review-webhook', 'maestro-review-orchestrator', 'maestro-review-settings-rpc',
    ]))
  })

  it('installs the new name in the reviewer-ci profile', () => {
    const profile = JSON.parse(read('profiles/reviewer-ci/package.json')) as { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
    expect(profile.dependencies['@ddtcorex/maestro-reviewer']).toBe(pkg.version)
    expect(profile.dependencies).not.toHaveProperty('@ddtcorex/dsh-maestro-review')
    expect(profile.dsh.profile.bundles).toContain('@ddtcorex/maestro-reviewer')
  })

  it('keeps the persisted legacy contracts', () => {
    expect(REVIEW_SOURCE_KIND).toBe('plugin:@ddtcorex/dsh-maestro-review')
    expect(historyPath('/h')).toBe(join('/h', 'dsh-maestro-review', 'reviews.json'))
    expect(runtimeStatePath('/h')).toBe(join('/h', 'dsh-maestro-review', 'runtime.json'))
    expect(read('docker/entrypoint.sh')).toContain('/app/dsh-maestro-review')
    expect(read('src/host/orchestrator.ts')).toContain("'dsh-maestro-reviewer'")
  })

  it('mentions the old name only for legacy contracts', () => {
    // `dsh-maestro-reviewer` / `dsh-maestro-auditor` are preset ids, not the old package name.
    const OLD = /dsh-maestro-review(?!er)/
    const ALLOWED_FILES = [/^CHANGELOG\.md$/, /^tests\/package-identity\.test\.ts$/]
    const ALLOWED_LINES = [
      /plugin:@ddtcorex\/dsh-maestro-review/, // persisted message source kind
      /dsh-maestro-review\/(reviews|runtime)\.json/, // on-disk data dir
      /'dsh-maestro-review', '(reviews|runtime)\.json'/,
      /\/app\/dsh-maestro-review/, // image history symlink
      /Renamed from `@ddtcorex\/dsh-maestro-review`/,
    ]
    const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean)
    const offenders: string[] = []
    for (const f of files) {
      if (ALLOWED_FILES.some(r => r.test(f))) continue
      let text: string
      try { text = read(f) } catch { continue }
      text.split('\n').forEach((line, i) => {
        if (OLD.test(line) && !ALLOWED_LINES.some(r => r.test(line))) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
