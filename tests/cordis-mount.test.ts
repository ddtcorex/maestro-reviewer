import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf-8')
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  name: string
  main: string
}

describe('cordis patch mounting', () => {
  it('mounts the plugin root so apply() actually runs on install', () => {
    // Without this row the provider registration in src/host/index.ts is never
    // executed: `dsh plugin add <pkg>` applies only the rows in this file, and a
    // row naming a submodule path never reaches lib/index.js's apply().
    // (The meta bundle happens to mount the bare name, which is why the gap
    // stayed invisible — a direct install got a silent no-op.)
    const rows = patch.split('\n').filter(line => line.includes('name:'))
    const bareName = rows.find(line => line.includes(`'${pkg.name}'`))
    expect(bareName, 'no row mounts the package root').toBeDefined()
  })

  it('declares the services apply() reads on the mounting row', () => {
    // Row-level inject (not module-level) is what populates ctx.get('skills').
    const block = patch.slice(patch.indexOf(`'${pkg.name}'`))
    const rowInject = block.slice(0, block.indexOf('insert:'))
    expect(patch).toMatch(/inject:[\s\S]*?'skills'/)
    expect(rowInject.length).toBeGreaterThan(0)
  })

  it('ships the engine row and none of the DSH host rows', () => {
    expect(patch).toContain('lib/engine-row.js')
    for (const hostOnly of ['providers/gitlab.js', 'orchestrator.js', 'settings-rpc.js', '- id: connection'])
      expect(patch, hostOnly).not.toContain(hostOnly)
  })

  it('never declares a web-only service on the mounting row', () => {
    // apply() reads exactly one service — `skills`, through ctx.get() — so the
    // mounting row declares that one and nothing else. Declaring the web
    // `connection` service (as 0.8.0 did) left the row PENDING FOREVER in any
    // headless profile that has no web layer: boot died with
    //   "plugin tree failed to load: 1 entry did not activate
    //    @ddtcorex/maestro-reviewer: pending (waiting for service: connection)"
    // which is exactly how the published reviewer-ci image failed on a real run
    // (2026-09-22). The settings RPC that genuinely needs `connection` lives in
    // its own row (settings-rpc.js), which a headless profile disables.
    const hostRow = patch.slice(
      patch.indexOf('- id: maestro-review-host'),
      patch.indexOf('- id: maestro-review-webhook'),
    )
    expect(hostRow, 'the mounting row is missing from the patch').not.toBe('')
    expect(hostRow).toMatch(/inject:\s*\['skills'\]/)
    expect(hostRow).not.toContain('connection')
  })
})
