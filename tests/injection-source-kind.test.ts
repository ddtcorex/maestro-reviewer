import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { REVIEW_SOURCE_KIND } from '../src/host/source.js'

// The reviewer and auditor prompts are injected by this plugin, not typed by a
// human. Declaring `kind: 'user'` made them indistinguishable from a human
// prompt for every consumer that classifies a turn by its source kind, and a
// bare 'plugin' is rejected outright by session format v4. The reviewer session
// keeps its own explicit title because the harness only auto-titles a
// kind-'user' message.
describe('review message attribution', () => {
  it('has a producer-owned kind and never claims a human prompt', () => {
    expect(REVIEW_SOURCE_KIND).toBe('plugin:@ddtcorex/dsh-maestro-review')
    expect(REVIEW_SOURCE_KIND).not.toBe('user')
    expect(REVIEW_SOURCE_KIND).not.toBe('plugin')

    const src = readFileSync(new URL('../src/host/engine.ts', import.meta.url), 'utf8')
    const attributed = src.match(/source: \{ kind: REVIEW_SOURCE_KIND \}/g) ?? []
    expect(attributed, 'both injections must use the shared constant').toHaveLength(2)
    expect(src, 'no injection may claim a human prompt').not.toMatch(/source: \{ kind: 'user' \}/)
  })

  it('keeps an explicit title for both review sessions', () => {
    const src = readFileSync(new URL('../src/host/engine.ts', import.meta.url), 'utf8')
    expect((src.match(/sessionTitle\.rename\(handle\.agent\.session, `Maestro Reviewer — MR !/g) ?? [])).toHaveLength(1)
    expect((src.match(/sessionTitle\.rename\(handle\.agent\.session, `Maestro Auditor — MR !/g) ?? [])).toHaveLength(1)
  })
})
