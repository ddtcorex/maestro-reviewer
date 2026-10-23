// release-bot: pure helpers behind .github/workflows/release-pin-and-image.yml.
//
// The workflow file itself stays thin `gh`/`docker` invocations; every
// branchable decision lives here so vitest can cover it offline. Nothing in
// this module touches the network by default except findExistingPinPr's
// `gh` call, and even that accepts an injected `runGh` fake so tests never
// hit the GitHub API.
//
// Conventions (from Task 1):
//   bot branch  chore/pin-reviewer-ci-X.Y.Z
//   tag         vX.Y.Z
//   image       ddtcorex/maestro-reviewer (:X.Y.Z + :latest)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const REVIEWER_PACKAGE = '@ddtcorex/maestro-reviewer'
export const IMAGE_REPO = 'ddtcorex/maestro-reviewer'

// The only files a pin PR may touch. Anything else in the diff is unrelated
// transitive churn and must fail the workflow closed.
export const PIN_ALLOWLIST = [
  'profiles/reviewer-ci/package.json',
  'profiles/reviewer-ci/pnpm-lock.yaml',
]

// pinBranchFor('0.19.5') -> 'chore/pin-reviewer-ci-0.19.5'.
export function pinBranchFor(version) {
  return `chore/pin-reviewer-ci-${version}`
}

// lockfileDiffAllowed(diffNames) is true only for a non-empty diff confined
// to PIN_ALLOWLIST. Empty fails closed: a pin run that changed nothing did
// not land the new version.
export function lockfileDiffAllowed(diffNames) {
  return diffNames.length > 0 && diffNames.every((f) => PIN_ALLOWLIST.includes(f))
}

// imageTagFor('0.19.5') -> 'ddtcorex/maestro-reviewer:0.19.5'.
// Tags are always per-version and explicit: the build job derives the version
// from the lockfile at build time (R4), never from the tag name alone.
export function imageTagFor(lockfileVersion) {
  return `${IMAGE_REPO}:${lockfileVersion}`
}

// readLockedReviewerVersion(profileDir) reads the currently locked
// @ddtcorex/maestro-reviewer version from the profile's pnpm-lock.yaml
// (importers entry, peer suffix stripped), or undefined when the lockfile is
// unreadable or holds no such entry. Dependency-free narrow parse; the
// lockfile shape is pnpm's contract.
export function readLockedReviewerVersion(profileDir) {
  let lock
  try {
    lock = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf-8')
  } catch {
    return undefined
  }
  const lines = lock.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*['"]?@ddtcorex\/maestro-reviewer['"]?:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = /^\s*version:\s*(\d+\.\d+\.\d+)/.exec(lines[j])
        if (m) return m[1]
        if (/^\s*@?\S+:\s*$/.test(lines[j]) && !/^\s*specifier:/.test(lines[j])) break
      }
    }
  }
  return undefined
}

// waitForRegistry(version, { timeoutMs, poll, now, sleep, intervalMs })
// resolves once `poll()` returns exactly `version`, and rejects with a
// version-naming error once `timeoutMs` elapses. The timeout path performs
// zero side effects: this helper only polls, it never creates anything.
// `now`/`sleep`/`intervalMs` are injectable for offline tests; the workflow
// passes the 20 s / 15 min cadence from the brief.
export async function waitForRegistry(
  version,
  { timeoutMs, poll, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), intervalMs = 20_000 },
) {
  const deadline = now() + timeoutMs
  for (;;) {
    const seen = await poll()
    if (seen === version) return
    if (now() >= deadline) {
      throw new Error(
        `timed out waiting for ${REVIEWER_PACKAGE}@${version} in the npm registry (last saw: ${seen ?? '(nothing)'})`,
      )
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
  }
}

// findExistingPinPr(version, { runGh }) returns the open pin-PR number for
// `version`, or undefined when there is none. The default `runGh` shells to
// the `gh` CLI (preinstalled on runners); tests inject a fake so they never
// hit the GitHub API. The caller updates the existing PR's branch instead of
// creating a duplicate when a number comes back (idempotent re-runs of a
// retried tag workflow).
export async function findExistingPinPr(version, { runGh = defaultRunGh } = {}) {
  const branch = pinBranchFor(version)
  const raw = await runGh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,headRefName'])
  let prs
  try {
    prs = JSON.parse(raw || '[]')
  } catch {
    return undefined
  }
  return prs.find((pr) => pr.headRefName === branch)?.number
}

function defaultRunGh(args) {
  return Promise.resolve(execFileSync('gh', args, { encoding: 'utf-8' }).trim())
}
