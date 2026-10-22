// release-prep: prepare a maestro-reviewer release PR.
//
// Usage: node scripts/release-prep.mjs X.Y.Z --rig-proof <path>
//   [--pr-refs <text>] [--date YYYY-MM-DD] [--skip-skills-update]
//
// Gates (any failure exits non-zero and names the failing gate):
//   version      exact X.Y.Z, no prerelease
//   clean-tree   `git status --porcelain` is empty
//   branch       current branch is chore/release-X.Y.Z
//   rig-proof    proof file holds the full HEAD SHA plus tier 1 + tier 2 PASS
//   skills-diff  the profile lock update touches only skills entries
//   checks       `pnpm verify && pnpm build && pnpm test` is green
//
// On success (exit 0) the script prints the exact branch/PR/tag commands.
// It never commits, pushes, merges or tags; the tag commands it prints are
// guarded and require explicit human approval first.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth for every file carrying a version literal.
export const REFERENCE_PATHS = [
  'package.json',
  'CHANGELOG.md',
  'docker/Dockerfile',
  'templates/reviewer-project.gitlab-ci.yml',
  'docs/ci-reviewer-setup.md',
  'profiles/reviewer-ci/package.json',
]

export const SKILLS_PACKAGE = '@ddtcorex/maestro-skills'
export const REVIEWER_PACKAGE = '@ddtcorex/maestro-reviewer'

// parseVersion('0.19.5') -> { major: 0, minor: 19, patch: 5 };
// anything else (prerelease, junk) -> undefined.
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

// checkRigProof(proofPath, headSha) verifies the local rig evidence: the
// file must exist, contain the full HEAD SHA, and carry PASS markers for
// both tier 1 and tier 2 (the keywords `tier 1` + `tier 2` plus a pass
// indication). Never names a gate beyond its reason string.
export function checkRigProof(proofPath, headSha) {
  let content
  try {
    content = readFileSync(proofPath, 'utf-8')
  } catch {
    return { ok: false, reason: `rig proof not found: ${proofPath}` }
  }
  if (!content.includes(headSha)) {
    return { ok: false, reason: `rig proof does not reference HEAD SHA ${headSha}` }
  }
  const lower = content.toLowerCase()
  const hasTier1 = /tier[\s-]*1(?!\d)/.test(lower)
  const hasTier2 = /tier[\s-]*2(?!\d)/.test(lower)
  const hasPass = /\bpass(es|ed|ing)?\b/.test(lower)
  if (!hasTier1 || !hasTier2 || !hasPass) {
    const missing = [
      !hasTier1 ? 'tier 1' : null,
      !hasTier2 ? 'tier 2' : null,
      !hasPass ? 'PASS' : null,
    ].filter(Boolean)
    return { ok: false, reason: `rig proof missing PASS marker(s): ${missing.join(', ')}` }
  }
  return { ok: true }
}

// insertChangelog(root, next, date, prRefs) prepends a Keep-a-Changelog
// `## [next] - date` section carrying prRefs above the newest entry.
export function insertChangelog(root, next, date, prRefs) {
  const path = join(root, 'CHANGELOG.md')
  const content = readFileSync(path, 'utf-8')
  const header = '# Changelog'
  if (!content.startsWith(header)) {
    throw new Error('CHANGELOG.md does not start with "# Changelog"')
  }
  const section = `## [${next}] - ${date}\n\n${prRefs}\n`
  const rest = content.slice(header.length).replace(/^\n+/, '')
  writeFileSync(path, `${header}\n\n${section}\n${rest}`)
}

// syncReferences(root, next) rewrites the previous version (read from the
// root package.json before the bump) to `next` across REFERENCE_PATHS and
// returns the changed files (relative paths, REFERENCE_PATHS order).
// Two paths are deliberately partial: CHANGELOG.md is owned by
// insertChangelog (a literal replacement would rewrite history), and the
// `@ddtcorex/maestro-reviewer` pin line in profiles/reviewer-ci/package.json
// is owned by the bot pin flow, never by the sync.
export function syncReferences(root, next) {
  const pkgPath = join(root, 'package.json')
  const prev = JSON.parse(readFileSync(pkgPath, 'utf-8')).version
  if (!parseVersion(prev) || !parseVersion(next)) {
    throw new Error(`invalid version pair: ${prev} -> ${next}`)
  }
  if (prev === next) return []
  const changed = []
  for (const rel of REFERENCE_PATHS) {
    if (rel === 'CHANGELOG.md') continue
    const abs = join(root, rel)
    const before = readFileSync(abs, 'utf-8')
    let after
    if (rel === 'profiles/reviewer-ci/package.json') {
      after = before
        .split('\n')
        .map((line) =>
          line.includes(`"${REVIEWER_PACKAGE}"`) ? line : line.split(prev).join(next),
        )
        .join('\n')
    } else {
      after = before.split(prev).join(next)
    }
    if (after !== before) {
      writeFileSync(abs, after)
      changed.push(rel)
    }
  }
  return changed
}

// readLockedSkillsVersion(profileDir) reads the currently locked
// @ddtcorex/maestro-skills version from the profile's pnpm-lock.yaml
// (importers entry), or undefined when the lockfile is unreadable or holds
// no such entry (the CLI maps that to the skills-pin gate, never a throw).
// Dependency-free narrow parse; the lockfile shape is pnpm's contract.
export function readLockedSkillsVersion(profileDir) {
  let lock
  try {
    lock = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf-8')
  } catch {
    return undefined
  }
  const lines = lock.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*['"]?@ddtcorex\/maestro-skills['"]?:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = /^\s*version:\s*(\d+\.\d+\.\d+)/.exec(lines[j])
        if (m) return m[1]
        if (/^\s*@?\S+:\s*$/.test(lines[j]) && !/^\s*specifier:/.test(lines[j])) break
      }
    }
  }
  return undefined
}

// updateSkillsSpecifier(profileDir, latest) raises the
// @ddtcorex/maestro-skills specifier to `latest` (range prefix preserved) in
// the profile package.json. Throws when the profile has no dependencies
// object; the CLI maps that to the skills-pin gate. Returns the previous
// and next specifiers so the caller can decide whether a lock refresh is
// still needed.
export function updateSkillsSpecifier(profileDir, latest) {
  const profilePkgPath = join(profileDir, 'package.json')
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf-8'))
  if (!profilePkg.dependencies || typeof profilePkg.dependencies !== 'object') {
    throw new Error(`${profilePkgPath} has no dependencies object`)
  }
  const prevSpec = profilePkg.dependencies[SKILLS_PACKAGE] ?? ''
  const prefix = prevSpec.startsWith('~') ? '~' : '^'
  const nextSpec = `${prefix}${latest}`
  profilePkg.dependencies[SKILLS_PACKAGE] = nextSpec
  writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`)
  return { prevSpec, nextSpec }
}

// checkLockDiffTouchesOnlySkills(diff) asserts a profile lock update diff
// moves only skills entries. Lockfile detail lines (resolution, integrity,
// snapshot pins) carry no package name, so each added/removed line is judged
// by its entry: the nearest preceding package-key line. Structural keys
// (importers/packages/snapshots/dependencies/...) never reset the entry;
// any other key line opens a new entry. Unknown context fails closed.
// Pure and offline; tested against fixtures.
const LOCK_STRUCTURAL_KEYS = new Set([
  'importers',
  'packages',
  'snapshots',
  'dependencies',
  'devdependencies',
  'optionaldependencies',
  'peerdependencies',
  'specifiers',
])

export function checkLockDiffTouchesOnlySkills(diff) {
  const bad = []
  let entryIsSkills = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('@@')) {
      entryIsSkills = false
      continue
    }
    const kind = line[0]
    const changed = kind === '+' || kind === '-'
    const body = changed ? line.slice(1) : line
    const keyMatch = /^\s*['"]?([^'"\s:]+)['"]?:\s*$/.exec(body)
    if (keyMatch && !LOCK_STRUCTURAL_KEYS.has(keyMatch[1].toLowerCase())) {
      entryIsSkills = /maestro-skills/i.test(keyMatch[1])
      if (changed && !entryIsSkills) bad.push(line)
      continue
    }
    if (!changed) continue
    if (/maestro-skills/i.test(body)) continue
    if (/^\s*$/.test(body)) continue
    if (!entryIsSkills) bad.push(line)
  }
  if (bad.length > 0) {
    return {
      ok: false,
      reason: `profile lock diff touches non-skills entries: ${bad.slice(0, 5).join(' | ')}`,
    }
  }
  return { ok: true }
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fail(gate, reason) {
  process.stderr.write(`release-prep: gate failed [${gate}]: ${reason}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { version: undefined, rigProof: undefined, prRefs: undefined, date: undefined, skipSkillsUpdate: false }
  const rest = [...argv]
  if (rest.length > 0 && !rest[0].startsWith('--')) out.version = rest.shift()
  while (rest.length > 0) {
    const flag = rest.shift()
    if (flag === '--rig-proof') out.rigProof = rest.shift()
    else if (flag === '--pr-refs') out.prRefs = rest.shift()
    else if (flag === '--date') out.date = rest.shift()
    else if (flag === '--skip-skills-update') out.skipSkillsUpdate = true
    else fail('args', `unknown flag: ${flag}`)
  }
  return out
}

function main() {
  const root = join(fileURLToPath(import.meta.url), '..', '..')
  const args = parseArgs(process.argv.slice(2))

  if (!parseVersion(args.version ?? '')) {
    fail('version', `expected exact X.Y.Z, got: ${args.version ?? '(missing)'}`)
  }
  const next = args.version
  if (!args.rigProof) fail('args', 'missing required --rig-proof <path>')

  const prev = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  if (!parseVersion(prev)) fail('version', `root package.json carries junk: ${prev}`)
  if (prev === next) fail('version', `already at ${next}: nothing to release`)
  const expectedBranch = `chore/release-${next}`

  // Git probes: any failure (git absent, not a repo) is the git gate, never
  // an uncaught throw.
  let dirty, branch, headSha
  try {
    dirty = run('git', ['status', '--porcelain'], root)
    branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)
    headSha = run('git', ['rev-parse', 'HEAD'], root)
  } catch (err) {
    fail('git', `git probe failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
  if (dirty !== '') fail('clean-tree', `working tree is not clean:\n${dirty}`)

  if (branch !== expectedBranch) {
    fail('branch', `expected branch ${expectedBranch}, on ${branch}`)
  }

  const proof = checkRigProof(args.rigProof, headSha)
  if (!proof.ok) fail('rig-proof', proof.reason)

  // Edits: reference sync (owns the root package.json bump too), then the
  // changelog entry. syncReferences must run before insertChangelog reads
  // anything version-shaped, and before package.json carries `next`.
  const changed = syncReferences(root, next)
  const today = args.date ?? new Date().toISOString().slice(0, 10)
  const prRefs = args.prRefs ?? `Bundles the merged PRs since ${prev}.`
  try {
    insertChangelog(root, next, today, prRefs)
  } catch (err) {
    fail('changelog', err instanceof Error ? err.message : String(err))
  }

  // Skills pin: raise the specifier to the latest published version, refresh
  // the profile lock, and prove the lock diff touches only skills entries.
  // When the lock already resolves the latest version, the update is a
  // no-op that can only drag unrelated transitive churn along, so it is
  // skipped (the specifier edit above still lands when it changed).
  const profileDir = join(root, 'profiles', 'reviewer-ci')
  if (!args.skipSkillsUpdate) {
    let latest
    try {
      latest = run('npm', ['view', `${SKILLS_PACKAGE}`, 'version'], root)
    } catch {
      fail('skills-pin', `cannot read latest ${SKILLS_PACKAGE} via npm view`)
    }
    if (!parseVersion(latest)) fail('skills-pin', `npm view returned junk: ${latest}`)
    let specs
    try {
      specs = updateSkillsSpecifier(profileDir, latest)
    } catch (err) {
      fail('skills-pin', err instanceof Error ? err.message : String(err))
    }
    const locked = readLockedSkillsVersion(profileDir)
    if (locked === undefined) {
      fail('skills-pin', `cannot read locked ${SKILLS_PACKAGE} version from ${join(profileDir, 'pnpm-lock.yaml')}`)
    }
    if (specs.prevSpec === specs.nextSpec && locked === latest) {
      process.stdout.write(`skills pin already current (${SKILLS_PACKAGE} ${latest}); skipping pnpm update\n`)
    } else {
      try {
        execFileSync(
          'pnpm',
          ['--config.minimumReleaseAge=0', 'update', SKILLS_PACKAGE],
          { cwd: profileDir, stdio: 'inherit' },
        )
      } catch {
        fail('skills-pin', `pnpm update ${SKILLS_PACKAGE} failed in profiles/reviewer-ci`)
      }
      const lockDiff = run('git', ['diff', '--', 'profiles/reviewer-ci/pnpm-lock.yaml'], root)
      const lockCheck = checkLockDiffTouchesOnlySkills(lockDiff)
      if (!lockCheck.ok) fail('skills-diff', lockCheck.reason)
    }
  }

  // Checks run last, against the edited tree. Build precedes test: lib/ is
  // gitignored, so a fresh release branch has no lib/ until it is built,
  // and engine-exports.test.ts requires it.
  for (const script of ['verify', 'build', 'test']) {
    try {
      execFileSync('pnpm', [script], { cwd: root, stdio: 'inherit' })
    } catch {
      fail('checks', `pnpm ${script} failed`)
    }
  }

  const changedLines = changed.length > 0 ? changed.map((f) => `  - ${f}`).join('\n') : '  (none)'
  process.stdout.write(
    [
      `release-prep ${prev} -> ${next} OK`,
      `changed references:\n${changedLines}`,
      'next steps (run these yourself; the tag commands need explicit human approval first):',
      `  git -C ${root} add -A && git -C ${root} commit -m "chore(release): ${next}"`,
      `  git -C ${root} push -u origin ${expectedBranch}`,
      `  gh pr create --title "chore(release): ${next}" --body "Release ${next}."`,
      'guarded tag commands (approval first, then run byte-identical):',
      `  git -C ${root} tag v${next}`,
      `  git -C ${root} push origin v${next}`,
      '',
    ].join('\n'),
  )
}

// Only run the CLI when invoked directly; imports (e.g. vitest) get the
// pure helpers without side effects.
const invokedAsScript =
  process.argv[1] !== undefined &&
  resolve(process.cwd(), process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) main()
