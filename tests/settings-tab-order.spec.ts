import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/index.tsx'), 'utf8')

describe('maestro-review settings section', () => {
  it('declares id maestro-review at order 32', () => {
    // 25 belongs to upstream's archived-sessions page, 26-29 are the Maestro
    // block, 31 is maestro-remote and 40 is Sutunam. Two sections sharing a
    // number have no defined relative order, which is how the Maestro tab and
    // archived-sessions used to swap places between loads.
    expect(entry).toMatch(/id:\s*'maestro-review'[\s\S]{0,400}?order:\s*32/)
  })

  it('never reuses an order another section already claims', () => {
    for (const taken of [25, 26, 27, 28, 29, 31, 33, 40]) {
      expect(entry, `order ${taken}`).not.toMatch(new RegExp(`order:\\s*${taken}\\b`))
    }
  })

  it('serves only this package own channel', () => {
    expect(entry).toContain("'/maestro-reviewer'")
    // The tunnel and telegram endpoints left with their owners; a card that
    // still dialled them would save into a channel that no longer serves them.
    expect(entry).not.toContain('/dsh-maestro-remote')
    expect(entry).not.toContain('/dsh-maestro-notifier')
  })

  it('registers exactly one section', () => {
    expect(entry.match(/id:\s*'maestro-review'/g)?.length ?? 0).toBe(1)
  })
})