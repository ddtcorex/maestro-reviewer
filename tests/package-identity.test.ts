import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { historyPath } from '../src/host/review-history.js'
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
    const files = ['cordis.patch.yml', 'presets/maestro-reviewer.patch.yml', 'presets/maestro-auditor.patch.yml', 'profiles/reviewer-ci/cordis.patch.yml']
    const docs = files.map(f => parse(read(f)))
    const names = docs.flatMap(d => moduleNames(d))
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n, n).toMatch(/^@ddtcorex\/maestro-reviewer(\/|$)/)
    // The DSH host rows (webhook, host orchestrator, settings RPC) ship in @ddtcorex/dsh-maestro-review.
    expect(rowIds(docs[0])).toEqual(['maestro-review-host', 'maestro-review-engine'])
  })

  it('installs the new name in the reviewer-ci profile', () => {
    const profile = JSON.parse(read('profiles/reviewer-ci/package.json')) as { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
    // The release commit bumps the package first; the pin follows in its own
    // PR once the version is on npm (AGENTS.md release checklist, step 3).
    const pin = profile.dependencies['@ddtcorex/maestro-reviewer']
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    const num = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0)
    expect(num(pin)).toBeLessThanOrEqual(num((pkg as unknown as { version: string }).version))
    expect(profile.dependencies).not.toHaveProperty('@ddtcorex/dsh-maestro-review')
    expect(profile.dsh.profile.bundles).toContain('@ddtcorex/maestro-reviewer')
  })

  it('keeps the persisted legacy contracts', () => {
    expect(REVIEW_SOURCE_KIND).toBe('plugin:@ddtcorex/dsh-maestro-review')
    expect(historyPath('/h')).toBe(join('/h', 'dsh-maestro-review', 'reviews.json'))
    expect(read('docker/entrypoint.sh')).toContain('/app/dsh-maestro-review')
    expect(read('src/host/engine.ts')).toContain("'dsh-maestro-reviewer'")
  })
})
