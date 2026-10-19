import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('reviewer-ci rows', () => {
  const profile = readFileSync('profiles/reviewer-ci/cordis.patch.yml', 'utf-8')
  const bundle = readFileSync('cordis.patch.yml', 'utf-8')

  it('the bundle provides the engine row with the services the agents need', () => {
    expect(bundle).toMatch(/- id: maestro-review-engine\n\s+name: '@ddtcorex\/maestro-reviewer\/lib\/engine-row\.js'\n\s+inject: \['agentDefaultModel', 'agents', 'agentPresets', 'sessionTitle'\]/)
  })

  it('the CI trigger runs through the engine, with no host orchestrator, webhook or settings row', () => {
    expect(profile).toMatch(/- id: maestro-review-ci-trigger\n\s+name: '@ddtcorex\/maestro-reviewer\/lib\/providers\/ci-trigger\.js'/)
    for (const id of ['maestro-review-orchestrator', 'maestro-review-webhook', 'maestro-review-settings-rpc']) {
      expect(profile).not.toMatch(new RegExp(`- id: ${id}\\b`))
      expect(bundle).not.toMatch(new RegExp(`- id: ${id}\\b`))
    }
  })

  it('the engine no longer detects CI from the environment', async () => {
    const orchestrator = await import('../src/host/orchestrator.js') as Record<string, unknown>
    expect(orchestrator.shouldCiDeepReview).toBeUndefined()
    expect(orchestrator.shouldCiQuickProfileReview).toBeUndefined()
    expect(readFileSync('src/host/engine.ts', 'utf-8')).not.toMatch(/process\.env/)
  })
})

describe('profiles/reviewer-ci/cordis.patch.yml', () => {
  it('botUsername reads from REVIEW_BOT_USERNAME (falling back to maestro-bot) instead of a bare hardcoded value', () => {
    // The orchestrator's `botUsername` config also drives review-signals.ts's
    // unawardOwn() (clearing the running "eyes" marker) and gitlab-client.ts's
    // selectOwnThreads() (dedup/reply detection) — both filter GitLab objects
    // by `author.username === botUsername`. A hardcoded "maestro-bot" that
    // doesn't match the real identity behind MAESTRO_GITLAB_TOKEN (a personal
    // PAT posts as its owner's username, not "maestro-bot") means neither
    // check ever recognizes the reviewer's own objects: stale "eyes" markers
    // never get cleared, and re-reviews can't tell their own prior threads
    // apart from anyone else's — found live 2026-09-05 (every award_emoji
    // during today's real E2E tests was posted as the token owner's real
    // GitLab username, never "maestro-bot").
    // Since the engine split the CI trigger reads it from the environment itself.
    const src = readFileSync('src/host/providers/ci-trigger.ts', 'utf-8')
    expect(src).toMatch(/botUsername: env\.REVIEW_BOT_USERNAME \|\| 'maestro-bot'/)
  })
})

/**
 * Preset delivery, end to end across the three files that have to agree.
 *
 * The orchestrator mounts presets by id (`agentPresets.mount(agentCtx,
 * 'dsh-maestro-reviewer')`). On DSH 0.1.7 the registry resolves ids from loader
 * rows naming `@deepseek-ai/dsh-agent-preset` — `@deepseek-ai/dsh-agent-preset-registry`
 * injects `['loader', 'sessionProjections']`, and no package in the 0.1.7 tree
 * reads `$DSH_HOME/.agent-presets` any more (verified 2026-09-24 by grepping
 * every package's `src/`, and by running the retired provider's
 * `discoverPresets()` against a temp home, which was the only thing that found
 * them). The retired plural `@deepseek-ai/dsh-agent-presets` is therefore gone
 * from the profile, and the declarations ship inside the plugin bundle instead:
 * `dsh.bundle.patch` lists the two preset patch files, so every profile that
 * composes the bundle — headless CI and the web app alike — gets the rows
 * without copying a directory anywhere.
 *
 * Get any one of the three out of step and the failure is silent until a real
 * review runs: no provider row means the service never exists, a missing patch
 * file means the preset id resolves to nothing, and a profile that re-`insert`s
 * an id the bundle already declares fails the boot with a duplicate entry.
 */
describe('reviewer-ci preset delivery', () => {
  const patch = readFileSync('profiles/reviewer-ci/cordis.patch.yml', 'utf-8')
  const manifest = JSON.parse(readFileSync('package.json', 'utf-8')) as {
    dsh?: { bundle?: { patch?: string | string[] } }
  }
  const patches = manifest.dsh?.bundle?.patch
  const patchFiles = Array.isArray(patches) ? patches : patches === undefined ? [] : [patches]

  it('gets its provider row from the 0.1.7 registry, exactly once', () => {
    expect(patch).toMatch(/id: agent-preset-registry/)
    expect(patch).toMatch(/name:\s*'@deepseek-ai\/dsh-agent-preset-registry'/)
    expect(patch).not.toMatch(/@deepseek-ai\/dsh-agent-presets['"]/)
    expect(patch.match(/id: agent-preset-registry/g)).toHaveLength(1)
  })

  it('ships both preset declarations as bundle patch files', () => {
    expect(patchFiles).toContain('./presets/maestro-reviewer.patch.yml')
    expect(patchFiles).toContain('./presets/maestro-auditor.patch.yml')
    for (const [file, id] of [
      ['./presets/maestro-reviewer.patch.yml', 'preset-dsh-maestro-reviewer'],
      ['./presets/maestro-auditor.patch.yml', 'preset-dsh-maestro-auditor'],
    ] as const) {
      const yml = readFileSync(file, 'utf-8')
      expect(yml, file).toMatch(new RegExp(`- id: ${id}\\n\\s+name: '@deepseek-ai/dsh-agent-preset'`))
    }
  })

  it('leaves directory-based delivery out of the image entirely', () => {
    const dockerfile = readFileSync('docker/Dockerfile', 'utf-8')
    expect(dockerfile).not.toMatch(/COPY presets\//)
    expect(dockerfile).not.toMatch(/\.agent-presets\//)
  })
})
