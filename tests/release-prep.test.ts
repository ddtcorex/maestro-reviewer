import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  REFERENCE_PATHS,
  checkLockDiffTouchesOnlySkills,
  checkRigProof,
  insertChangelog,
  parseVersion,
  readLockedSkillsVersion,
  syncReferences,
  updateSkillsSpecifier,
} from '../scripts/release-prep.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('parseVersion', () => {
  it('accepts exact X.Y.Z', () => {
    expect(parseVersion('0.19.5')).toEqual({ major: 0, minor: 19, patch: 5 })
  })
  it('rejects prerelease and junk', () => {
    expect(parseVersion('0.19.5-rc.1')).toBeUndefined()
    expect(parseVersion('not-a-version')).toBeUndefined()
  })
})

describe('checkRigProof', () => {
  it('rejects a missing proof file', () => {
    const r = checkRigProof('/no/such/file', 'abc123')
    expect(r.ok).toBe(false)
  })
  it('rejects a proof that does not reference the HEAD SHA', () => {
    const r = checkRigProof(fixture('rig-proof-wrong-sha.txt'), 'abc123')
    expect(r.ok).toBe(false)
  })
  it('accepts a proof with the HEAD SHA and tier 1 + tier 2 PASS markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-proof-'))
    const proof = join(dir, 'proof.txt')
    writeFileSync(
      proof,
      'rig run for HEAD deadbeef1234\ntier 1: PASS\ntier 2: PASS\n',
    )
    expect(checkRigProof(proof, 'deadbeef1234')).toEqual({ ok: true })
  })
  it('rejects a proof missing the tier PASS markers even with the right SHA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-proof-'))
    const proof = join(dir, 'proof.txt')
    writeFileSync(proof, 'rig run for HEAD deadbeef1234\ntier 1: PASS\n')
    const r = checkRigProof(proof, 'deadbeef1234')
    expect(r.ok).toBe(false)
  })
  it('rejects a proof where tier 2 failed despite a passing count line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-proof-'))
    const proof = join(dir, 'proof.txt')
    writeFileSync(
      proof,
      'rig run for HEAD deadbeef1234\ntier 1: PASS\ntier 2: FAIL\n3 passed, 1 failed\n',
    )
    const r = checkRigProof(proof, 'deadbeef1234')
    expect(r.ok).toBe(false)
  })
  it('rejects a proof where tier 1 failed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-proof-'))
    const proof = join(dir, 'proof.txt')
    writeFileSync(
      proof,
      'rig run for HEAD deadbeef1234\ntier 1: FAIL\ntier 2: PASS\n',
    )
    const r = checkRigProof(proof, 'deadbeef1234')
    expect(r.ok).toBe(false)
  })
  it('accepts sectioned rig output with PASS verdicts after the tier headers', () => {
    const r = checkRigProof(
      fixture('rig-proof-sections-pass.txt'),
      'deadbeef1234feedface00112233445566778899aabb',
    )
    expect(r).toEqual({ ok: true })
  })
  it('rejects sectioned rig output with a failure count in the tier 2 section', () => {
    const r = checkRigProof(
      fixture('rig-proof-sections-tier2-fail.txt'),
      'deadbeef1234feedface00112233445566778899aabb',
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && (r as { reason: string }).reason).toMatch(/tier 2 FAIL/)
  })
})

describe('REFERENCE_PATHS', () => {
  it('resolves to an existing file under the repo root', () => {
    expect(REFERENCE_PATHS.length).toBeGreaterThan(0)
    for (const rel of REFERENCE_PATHS) {
      expect(existsSync(join(repoRoot, rel)), rel).toBe(true)
    }
  })
  it('is exactly the six known version-literal files', () => {
    expect(REFERENCE_PATHS).toEqual([
      'package.json',
      'CHANGELOG.md',
      'docker/Dockerfile',
      'templates/reviewer-project.gitlab-ci.yml',
      'docs/ci-reviewer-setup.md',
      'profiles/reviewer-ci/package.json',
    ])
  })
})

describe('syncReferences', () => {
  const writeTree = (root: string) => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify(
        {
          name: '@ddtcorex/maestro-reviewer',
          version: '0.19.4',
          scripts: {
            'docker:build':
              'docker build -f docker/Dockerfile -t ddtcorex/maestro-reviewer:0.19.4 -t ddtcorex/maestro-reviewer:latest .',
          },
        },
        null,
        2,
      ),
      'CHANGELOG.md': '# Changelog\n\n## [0.19.4] - 2026-10-22\n',
      'docker/Dockerfile':
        '# -t ddtcorex/maestro-reviewer:0.19.4 -t ddtcorex/maestro-reviewer:latest .\n',
      'templates/reviewer-project.gitlab-ci.yml':
        '  REVIEWER_IMAGE: "ddtcorex/maestro-reviewer:0.19.4"\n',
      'docs/ci-reviewer-setup.md':
        '(for example `ddtcorex/maestro-reviewer:0.19.4`).\n',
      'profiles/reviewer-ci/package.json': JSON.stringify(
        {
          dependencies: {
            '@ddtcorex/maestro-reviewer': '0.19.4',
            '@ddtcorex/maestro-skills': '^2.18.2',
          },
        },
        null,
        2,
      ),
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
  }

  it('rewrites 0.19.4 to 0.19.5 and returns the exact changed-files list', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-prep-'))
    writeTree(root)
    const changed = syncReferences(root, '0.19.5')
    expect(changed).toEqual([
      'package.json',
      'docker/Dockerfile',
      'templates/reviewer-project.gitlab-ci.yml',
      'docs/ci-reviewer-setup.md',
    ])
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version).toBe(
      '0.19.5',
    )
    expect(readFileSync(join(root, 'package.json'), 'utf-8')).toContain(
      'ddtcorex/maestro-reviewer:0.19.5',
    )
    expect(readFileSync(join(root, 'docker/Dockerfile'), 'utf-8')).toContain(
      'ddtcorex/maestro-reviewer:0.19.5',
    )
    expect(
      readFileSync(join(root, 'templates/reviewer-project.gitlab-ci.yml'), 'utf-8'),
    ).toContain('ddtcorex/maestro-reviewer:0.19.5')
    expect(readFileSync(join(root, 'docs/ci-reviewer-setup.md'), 'utf-8')).toContain(
      'ddtcorex/maestro-reviewer:0.19.5',
    )
    // CHANGELOG.md is owned by insertChangelog, never by literal replacement.
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf-8')).toContain('[0.19.4]')
    // The reviewer pin is owned by the release bot flow, never by the sync.
    expect(
      JSON.parse(readFileSync(join(root, 'profiles/reviewer-ci/package.json'), 'utf-8'))
        .dependencies['@ddtcorex/maestro-reviewer'],
    ).toBe('0.19.4')
  })
})

describe('insertChangelog', () => {
  it('inserts a new Keep-a-Changelog section at the top', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-prep-'))
    writeFileSync(root + '/CHANGELOG.md', '# Changelog\n\n## [0.19.4] - 2026-10-22\n')
    insertChangelog(root, '0.19.5', '2026-10-23', 'Bundles #210.')
    const content = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8')
    expect(content).toContain('## [0.19.5] - 2026-10-23')
    expect(content).toContain('Bundles #210.')
    expect(content.indexOf('## [0.19.5]')).toBeLessThan(
      content.indexOf('## [0.19.4]'),
    )
  })
})

describe('readLockedSkillsVersion', () => {
  it('reads the locked skills version from a pnpm lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-prep-'))
    writeFileSync(
      join(dir, 'pnpm-lock.yaml'),
      "importers:\n  .:\n    dependencies:\n      '@ddtcorex/maestro-skills':\n        specifier: ^2.18.2\n        version: 2.18.2(@deepseek-ai/cordis@4.0.4)\n",
    )
    expect(readLockedSkillsVersion(dir)).toBe('2.18.2')
  })
  it('reads the real profile lockfile', () => {
    expect(readLockedSkillsVersion(join(repoRoot, 'profiles', 'reviewer-ci'))).toMatch(
      /^\d+\.\d+\.\d+$/,
    )
  })
})

describe('checkLockDiffTouchesOnlySkills', () => {
  it('accepts a realistic skills-only lock diff', () => {
    const diff = [
      'diff --git a/profiles/reviewer-ci/pnpm-lock.yaml b/profiles/reviewer-ci/pnpm-lock.yaml',
      'index 111..222 100644',
      '--- a/profiles/reviewer-ci/pnpm-lock.yaml',
      '+++ b/profiles/reviewer-ci/pnpm-lock.yaml',
      '@@ -12,8 +12,8 @@ importers:',
      "       '@ddtcorex/maestro-skills':",
      '-        specifier: ^2.15.0',
      '-        version: 2.15.0',
      '+        specifier: ^2.18.2',
      '+        version: 2.18.2(@deepseek-ai/cordis@4.0.4)',
      '@@ -136,7 +136,7 @@ packages:',
      "-  '@ddtcorex/maestro-skills@2.15.0':",
      '-    resolution: {integrity: sha512-old==}',
      "+  '@ddtcorex/maestro-skills@2.18.2':",
      '+    resolution: {integrity: sha512-new==}',
      '@@ -4055,7 +4055,7 @@ snapshots:',
      "-  '@ddtcorex/maestro-skills@2.15.0(@deepseek-ai/cordis@4.0.4)':",
      "+  '@ddtcorex/maestro-skills@2.18.2(@deepseek-ai/cordis@4.0.4)':",
      '     dependencies:',
      "       '@deepseek-ai/cordis': 4.0.4(@deepseek-ai/cordis-plugin-include@1.0.9)(@deepseek-ai/cordis-plugin-loader@1.0.5)",
      '',
    ].join('\n')
    expect(checkLockDiffTouchesOnlySkills(diff)).toEqual({ ok: true })
  })
  it('accepts an empty diff', () => {
    expect(checkLockDiffTouchesOnlySkills('')).toEqual({ ok: true })
  })
  it('rejects unrelated transitive churn (fast-uri case)', () => {
    const diff = [
      "      '@ddtcorex/maestro-skills':",
      '         version: 2.18.2(@deepseek-ai/cordis@4.0.4)',
      '-  fast-uri@3.1.8:',
      '+  fast-uri@3.1.9:',
      '-    resolution: {integrity: sha512-old==}',
      '+    resolution: {integrity: sha512-new==}',
    ].join('\n')
    const r = checkLockDiffTouchesOnlySkills(diff)
    expect(r.ok).toBe(false)
    expect(r.ok === false && (r as { reason: string }).reason).toMatch(/fast-uri/)
  })
})

describe('failure gates name the gate', () => {
  it('readLockedSkillsVersion returns undefined (no throw) for a missing lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-prep-'))
    expect(readLockedSkillsVersion(dir)).toBeUndefined()
  })

  it('insertChangelog throws on a missing Changelog header', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-prep-'))
    writeFileSync(join(root, 'CHANGELOG.md'), 'no header here\n')
    expect(() => insertChangelog(root, '0.19.5', '2026-10-23', 'x')).toThrow(
      /does not start with "# Changelog"/,
    )
  })

  it('updateSkillsSpecifier throws when the profile has no dependencies object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-prep-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p' }))
    expect(() => updateSkillsSpecifier(dir, '2.18.2')).toThrow(/no dependencies object/)
  })

  it('updateSkillsSpecifier raises the specifier preserving the range prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-prep-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@ddtcorex/maestro-skills': '^2.15.0' } }),
    )
    expect(updateSkillsSpecifier(dir, '2.18.2')).toEqual({
      prevSpec: '^2.15.0',
      nextSpec: '^2.18.2',
    })
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).dependencies).toEqual(
      { '@ddtcorex/maestro-skills': '^2.18.2' },
    )
  })
})

describe('CLI gate failures', () => {
  const script = join(repoRoot, 'scripts', 'release-prep.mjs')
  const runCli = (args: string[], env?: NodeJS.ProcessEnv) => {
    try {
      execFileSync(process.execPath, [script, ...args], { encoding: 'utf-8', env })
      return { status: 0, stderr: '' }
    } catch (err: any) {
      return { status: err.status ?? 1, stderr: String(err.stderr ?? '') }
    }
  }

  it('names the version gate for junk input', () => {
    const r = runCli(['not-a-version', '--rig-proof', '/tmp/x'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/gate failed \[version\]/)
  })

  it('names the git gate when git is unavailable', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'release-prep-empty-path-'))
    const r = runCli(['9.9.9', '--rig-proof', '/tmp/x'], { PATH: emptyPath })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/gate failed \[git\]/)
  })
})
