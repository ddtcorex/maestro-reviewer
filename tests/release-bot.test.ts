import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findExistingPinPr,
  imageTagFor,
  lockfileDiffAllowed,
  pinBranchFor,
  readLockedReviewerVersion,
  waitForRegistry,
} from '../scripts/release-bot.mjs'

describe('lockfileDiffAllowed', () => {
  it('allows the pin-only diff', () => {
    expect(lockfileDiffAllowed([
      'profiles/reviewer-ci/package.json',
      'profiles/reviewer-ci/pnpm-lock.yaml',
    ])).toBe(true)
  })
  it('rejects unrelated churn', () => {
    expect(lockfileDiffAllowed([
      'profiles/reviewer-ci/pnpm-lock.yaml',
      'package.json',
    ])).toBe(false)
  })
  it('rejects an empty diff (nothing pinned: fail closed)', () => {
    expect(lockfileDiffAllowed([])).toBe(false)
  })
})

describe('imageTagFor', () => {
  it('tags per-version explicitly', () => { expect(imageTagFor('0.19.5')).toBe('ddtcorex/maestro-reviewer:0.19.5') })
})

describe('pinBranchFor', () => {
  it('names the bot branch Task 1 defined', () => {
    expect(pinBranchFor('0.19.5')).toBe('chore/pin-reviewer-ci-0.19.5')
  })
})

describe('waitForRegistry', () => {
  it('resolves once the poll observes the version', async () => {
    let calls = 0
    const poll = async () => {
      calls += 1
      return calls >= 3 ? '0.19.5' : '0.19.4'
    }
    await waitForRegistry('0.19.5', { timeoutMs: 60_000, poll, sleep: async () => {} })
    expect(calls).toBe(3)
  })
  it('rejects on timeout with zero side effects', async () => {
    let calls = 0
    const poll = async () => {
      calls += 1
      return '0.19.4'
    }
    await expect(waitForRegistry('0.19.5', { timeoutMs: 50, poll })).rejects.toThrow('0.19.5')
    // Zero side effects: the helper only polled, it created nothing.
    expect(calls).toBeGreaterThan(0)
  })
})

describe('findExistingPinPr', () => {
  const branch = 'chore/pin-reviewer-ci-0.19.5'
  it('returns the iid when an open pin PR exists (caller updates instead of creating)', async () => {
    const runGh = async () => JSON.stringify([{ number: 123, headRefName: branch }])
    await expect(findExistingPinPr('0.19.5', { runGh })).resolves.toBe(123)
  })
  it('ignores PRs on other branches', async () => {
    const runGh = async () => JSON.stringify([{ number: 124, headRefName: 'chore/release-0.19.5' }])
    await expect(findExistingPinPr('0.19.5', { runGh })).resolves.toBeUndefined()
  })
  it('returns undefined when no open pin PR exists (caller creates)', async () => {
    const runGh = async () => '[]'
    await expect(findExistingPinPr('0.19.5', { runGh })).resolves.toBeUndefined()
  })
})

describe('readLockedReviewerVersion', () => {
  const writeProfile = (lock: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-ci-'))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lock)
    return dir
  }
  const lockWith = (versionLine: string) =>
    `importers:\n\n  .:\n    dependencies:\n      '@ddtcorex/maestro-reviewer':\n        specifier: 0.19.5\n        ${versionLine}\n`
  it('reads the locked reviewer version (peer-suffixed)', () => {
    const dir = writeProfile(lockWith('version: 0.19.5(@deepseek-ai/cordis@4.0.4)'))
    expect(readLockedReviewerVersion(dir)).toBe('0.19.5')
  })
  it('reads a bare locked reviewer version', () => {
    const dir = writeProfile(lockWith('version: 0.19.5'))
    expect(readLockedReviewerVersion(dir)).toBe('0.19.5')
  })
  it('returns undefined when the lockfile has no reviewer entry', () => {
    const dir = writeProfile('importers:\n\n  .:\n    dependencies:\n')
    expect(readLockedReviewerVersion(dir)).toBeUndefined()
  })
  it('returns undefined when the lockfile is unreadable', () => {
    expect(readLockedReviewerVersion(join(tmpdir(), 'reviewer-ci-missing-dir'))).toBeUndefined()
  })
})
