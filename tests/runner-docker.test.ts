import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('docker', () => {
  it('Dockerfile installs everything from registries (no host-checkout COPY)', () => {
    const df = readFileSync('docker/Dockerfile', 'utf-8')
    expect(df).toMatch(/ARG NODE_VERSION=22/)
    expect(df).toMatch(/FROM node:\$\{NODE_VERSION\}-slim AS runtime/)
    // The dsh CLI is a dependency of profiles/reviewer-ci itself (not a
    // separate `npm install -g`), so it shares the profile's own pnpm
    // resolution graph — a second, disjoint install of the same core
    // packages (dsh-scope, dsh-agent-loop, dsh-agent-presets, ...) produced
    // two physically distinct copies in the same process, and Cordis's
    // plugin loader picked a different one per plugin, so createScope()'s
    // Symbol("dsh.scope") tag and dsh-agent-presets' own check of it never
    // matched: "agent-presets: refusing to compose an unscoped context"
    // on every agent creation (root-caused 2026-09-05, confirmed fixed by
    // installing dsh inside the profile instead of globally).
    expect(df).not.toMatch(/npm install -g @deepseek-ai\/dsh@/)
    expect(df).toMatch(/node_modules\/\.bin.*PATH/)
    expect(df).not.toMatch(/COPY deepseek-harness/)
    expect(df).not.toMatch(/COPY packages\//)
    expect(df).not.toMatch(/AS builder/)
    // profile deps from the registry, frozen install, package-relative COPYs
    expect(df).toMatch(/COPY profiles\/reviewer-ci \.\/profiles\/reviewer-ci/)
    expect(df).toMatch(/pnpm --dir profiles\/reviewer-ci .* install --frozen-lockfile/)
    expect(df).toMatch(/ENV DSH_HOME=\/app\s*$/m)
    // Agent presets ship as bundle patch rows from the plugin package itself
    // (see tests/reviewer-ci-cordis-patch.test.ts); the .agent-presets COPY is
    // gone with the provider that used to read that directory.
    expect(df).not.toMatch(/COPY presets\//)
    expect(df).not.toMatch(/\.agent-presets\//)
    // deepseek is the sole baked default; opencode was removed entirely
    expect(df).toMatch(/ci-settings\.deepseek\.yaml \/app\/settings\.yaml/)
    expect(df).toMatch(/ci-settings\.generic-openai\.yaml \/app\/settings\.generic-openai\.yaml/)
    expect(df).not.toMatch(/opencode/i)
    expect(df).toMatch(/tini/)
    expect(df).toMatch(/ENTRYPOINT.*entrypoint\.sh/)
    // CI deep reviews clone the source at the MR head SHA — git must exist in the image.
    expect(df).toMatch(/apt-get install[^&]*\bgit\b/)
  })

  it('entrypoint.sh validates required env then execs dsh --profile reviewer-ci with no task text', () => {
    const sh = readFileSync('docker/entrypoint.sh', 'utf-8')
    expect(sh).toMatch(/MAESTRO_GITLAB_TOKEN/)
    expect(sh).toMatch(/SOURCE_PROJECT_ID/)
    expect(sh).toMatch(/MR_IID/)
    expect(sh).toMatch(/--profile reviewer-ci"?\s*$/m)
    expect(sh).not.toMatch(/cli\.js/)
    expect(sh).toMatch(/REVIEW_REPORT_DIR/)
    expect(sh).toMatch(/CI_PROJECT_DIR/)
    expect(sh).toMatch(/MAESTRO_GITLAB_TOKEN as a user\/project token/)
    expect(sh).toMatch(/GITLAB_TOKEN_KIND/)
    expect(sh).toMatch(/__CI_MANAGED__/)
    expect(sh).toMatch(/\.maestro-history/)
    expect(sh).toContain('/app/dsh-maestro-review')
    // opencode was removed entirely — no leftover references
    expect(sh).not.toMatch(/OPENCODE/)
  })

  it('entrypoint.sh overlays the generic OpenAI-compatible route only when REVIEW_LLM_API_KEY is set, otherwise keeps the baked deepseek default', () => {
    const sh = readFileSync('docker/entrypoint.sh', 'utf-8')
    expect(sh).toMatch(/REVIEW_LLM_API_KEY/)
    expect(sh).toMatch(/REVIEW_LLM_BASE_URL/)
    expect(sh).toMatch(/REVIEW_LLM_MODEL/)
    expect(sh).toMatch(/REVIEW_LLM_API\b/)
    expect(sh).toMatch(/settings\.generic-openai\.yaml/)
    // selection keys on the API key's presence, not the base URL
    const apiKeyIdx = sh.search(/REVIEW_LLM_API_KEY:-/)
    expect(apiKeyIdx).toBeGreaterThan(-1)
    // fails closed when the key is set but base URL / model are missing
    expect(sh).toMatch(/REVIEW_LLM_BASE_URL.*(is|must be) (required|set)/)
    expect(sh).toMatch(/REVIEW_LLM_MODEL.*(is|must be) (required|set)/)
    // only openai-completions/openai-responses are accepted (OpenAI-compatible only)
    expect(sh).toMatch(/openai-completions/)
    expect(sh).toMatch(/openai-responses/)
    // a stable per-job x-opencode-session id is always derived and substituted,
    // independent of any CI variable — GitLab's own CI_JOB_ID is unique per job
    // run (one job = one review "conversation"), with a local-run fallback
    expect(sh).toMatch(/REVIEW_LLM_SESSION_ID=.*CI_JOB_ID/)
    expect(sh).toMatch(/__REVIEW_LLM_SESSION_ID__/)
    // no more key-based opencode/deepseek swap branch — deepseek is simply the
    // baked default with nothing left to switch away from
    expect(sh).not.toMatch(/settings\.deepseek\.yaml/)
    expect(sh).not.toMatch(/\$\{?DEEPSEEK_API_KEY/)
  })

  it('ci-settings.generic-openai.yaml declares a bring-your-own OpenAI-compatible route with no embedded secrets', () => {
    const yml = readFileSync('docker/ci-settings.generic-openai.yaml', 'utf-8')
    expect(yml).toMatch(/^llm-pi-ai:/m)
    expect(yml).toMatch(/custom-openai:/)
    expect(yml).toMatch(/apiKeyEnv:\s*REVIEW_LLM_API_KEY/)
    expect(yml).toMatch(/api:\s*__REVIEW_LLM_API__/)
    expect(yml).toMatch(/baseURL:\s*__REVIEW_LLM_BASE_URL__/)
    expect(yml.match(/^\s+(?:- id|model): __REVIEW_LLM_MODEL__$/gm)).toHaveLength(2)
    expect(yml).toMatch(/^agent-default-model:/m)
    expect(yml).toMatch(/provider:\s*custom-openai/)
    expect(yml).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    expect(yml).not.toMatch(/glpat-[A-Za-z0-9_.-]{8,}/)
    // gateways that route by conversation (e.g. OpenCode Zen's "Go" route,
    // opencode.ai/zen/go/v1) reject requests missing a session header with a
    // hard 400 MissingSessionID — send a stable per-job id on every route so
    // a bring-your-own endpoint that enforces this never breaks the review.
    expect(yml).toMatch(/headers:\s*\n\s+x-opencode-session:\s*"__REVIEW_LLM_SESSION_ID__"/)
    // quoted so a numeric CI_JOB_ID substitution stays a YAML string, not a number
  })

  it('profiles/reviewer-ci pins @deepseek-ai/dsh as its own dependency, not a global install, so it shares one pnpm resolution graph', () => {
    const pkg = JSON.parse(readFileSync('profiles/reviewer-ci/package.json', 'utf-8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@deepseek-ai/dsh']).toBeTruthy()
  })

  // Root-caused 2026-09-14: declaring dsh-base directly here, at the same
  // version @deepseek-ai/dsh already depends on it, does not dedupe them —
  // pnpm still resolves two physically distinct instances (a different
  // peer-dependency context per requester, `pnpm why` shows two
  // `peersSuffixHash`es), because matching version strings isn't what pnpm
  // instance identity keys on. One instance provided the `skills` service
  // maestro-skills registered into and the other backed the reviewer's own
  // composition, so `ctx.skills.list()` inside the reviewer agent never saw
  // maestro-skills' entries — every profile-configured review failed with
  // "Missing required review skill(s)" despite the skill files being
  // present. dsh already depends on dsh-base on its own; this asserts we
  // never reintroduce the direct duplicate.
  it('does not duplicate @deepseek-ai/dsh-base as a direct dependency (dsh already carries it, and duplicating it splits the pnpm instance)', () => {
    const pkg = JSON.parse(readFileSync('profiles/reviewer-ci/package.json', 'utf-8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@deepseek-ai/dsh-base']).toBeUndefined()
  })

  it('ci-settings.deepseek.yaml is the sole baked default, serving deepseek-official from api.deepseek.com', () => {
    const yml = readFileSync('docker/ci-settings.deepseek.yaml', 'utf-8')
    expect(yml).toMatch(/__CI_MANAGED__/)
    expect(yml).toMatch(/llm-deepseek:/)
    expect(yml).toMatch(/apiKeyEnv:\s*DEEPSEEK_API_KEY/)
    expect(yml).toMatch(/baseURL:\s*https:\/\/api\.deepseek\.com/)
    expect(yml).toMatch(/provider:\s*deepseek-official/)
    expect(yml).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
  })
})
