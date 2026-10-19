import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8')

describe('review RPC channel ownership', () => {
  // Regression: mounting the package root (the `maestro-review-host` row added so
  // the skill provider actually runs) made apply() execute in a real boot for the
  // first time. apply() also registered a legacy stub on the review channel,
  // colliding with the real handler in settings-rpc.ts:
  //   maestro-review-settings-rpc: Error: webserver: duplicate prefix route "<review channel>"
  // The Settings card failed on a host that mounted both rows because of it.
  // Exactly one module may claim the channel, and it must be the one that
  // implements the endpoints.

  const channel = '/maestro-reviewer'

  it('registers the channel exactly once across src/', () => {
    const hosts = ['src/host/index.ts', 'src/host/settings-rpc.ts']
    const owners = hosts.filter(f => read(f).includes(`rpc.handle('${channel}'`) || read(f).includes('rpc.handle(MAESTRO_RPC_CHANNEL'))
    expect(owners, `channel ${channel} must have exactly one owner`).toEqual(['src/host/settings-rpc.ts'])
  })

  it('keeps apply() free of any rpc.handle call', () => {
    // apply() owns the skill provider only. Naming the channel in a comment that
    // explains the collision is fine and wanted; registering it is not.
    const index = read('src/host/index.ts')
    expect(index).not.toContain('rpc.handle')
    expect(index).not.toMatch(/^\s*ctx\.effect\([^)]*rpc/m)
  })

  it('leaves the real handler owning the channel constant', () => {
    const settings = read('src/host/settings-rpc.ts')
    expect(settings).toContain(`export const MAESTRO_RPC_CHANNEL = '${channel}'`)
    // handle() takes exactly (channel, handler) — a third `authority` argument
    // is not part of the API and is silently ignored at runtime.
    expect(settings).toContain('rpc.handle(MAESTRO_RPC_CHANNEL, handler)')
    expect(settings).not.toContain('authority')
  })

  it('dials the same channel from the client bundle', () => {
    expect(read('src/client/index.tsx')).toContain(`export const REVIEW_CHANNEL = '${channel}'`)
  })

  it('still serves the skill provider from apply()', () => {
    // The fix must not undo what the mounting row exists for.
    const index = read('src/host/index.ts')
    expect(index).toContain('registerProvider')
    expect(index).toContain('resolveSkillsDir')
  })
})
