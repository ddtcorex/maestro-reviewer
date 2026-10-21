import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { childPipelineYaml, decideRoute, noopChildYaml, parseCiConfigPath, parseMrRef, PROVIDER_PRESETS } from '../src/host/ci-resolve.js'

describe('parseCiConfigPath', () => {
  it('parses a file in another project, with an optional ref, the way GitLab splits it', () => {
    expect(parseCiConfigPath('maestro-reviewer.yml@my-group/reviewer-config')).toEqual({ file: 'maestro-reviewer.yml', project: 'my-group/reviewer-config' })
    expect(parseCiConfigPath('ci/review.yaml@a/b.c/d_e:stable')).toEqual({ file: 'ci/review.yaml', project: 'a/b.c/d_e', ref: 'stable' })
    expect(parseCiConfigPath('f.yml@g/p:release/1.0')).toEqual({ file: 'f.yml', project: 'g/p', ref: 'release/1.0' })
  })

  it('returns undefined for anything GitLab would not load from another project', () => {
    for (const v of [
      undefined, null, '', '  ', '.gitlab-ci.yml', 'ci/review.yml', '@g/p', 'f.yml@', 'f.yml@noslash', 'f.yml@g/p:', 'f.yml@g//p', 'f.yml@g/p x',
      // GitLab's external-project rule is case-sensitive and needs yml or yaml right before the @
      'maestro-reviewer.YML@g/p', 'maestro-reviewer@g/p', 'f.json@g/p',
      // GitLab loads any value with an http(s) scheme as a remote file, first
      'http://evil.example/p.yml@g/p', 'f.yml@g/p:https://x', 'HTTPS://x.yml@g/p',
      // GitLab splits on the first @: the project part must then be a plain path
      'a@b.yml@g/p',
      // GitLab does not trim
      ' f.yml@g/p', 'f.yml@g/p ',
    ]) {
      expect(parseCiConfigPath(v), String(v)).toBeUndefined()
    }
  })

  it('validates the project and ref GitLab would use when the ref holds an @', () => {
    expect(parseCiConfigPath('f.yml@dev/proj:x@grp/cfg')).toEqual({ file: 'f.yml', project: 'dev/proj', ref: 'x@grp/cfg' })
  })
})

describe('parseMrRef', () => {
  it('reads the MR iid from head, merge and train refs', () => {
    expect(parseMrRef('refs/merge-requests/12/head')).toBe(12)
    expect(parseMrRef('refs/merge-requests/7/merge')).toBe(7)
    expect(parseMrRef('refs/merge-requests/3/train')).toBe(3)
  })
  it('returns undefined for a branch or tag ref', () => {
    expect(parseMrRef('main')).toBeUndefined()
    expect(parseMrRef('refs/heads/main')).toBeUndefined()
    expect(parseMrRef('refs/merge-requests/x/head')).toBeUndefined()
  })
})

describe('decideRoute', () => {
  const key = { REVIEW_LLM_API_KEY: 'present' } as const
  it('uses the default route when the project scopes nothing', () => {
    expect(decideRoute({})).toEqual({ route: 'default' })
  })
  it('builds a project route from a preset', () => {
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'claude-x', REVIEW_LLM_PROVIDER: 'anthropic' }))
      .toEqual({ route: 'project', baseUrl: 'https://api.anthropic.com/v1', api: 'openai-completions', model: 'claude-x' })
  })
  it('ships exactly the spec presets', () => {
    expect(PROVIDER_PRESETS).toEqual({
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
      openrouter: 'https://openrouter.ai/api/v1',
      deepseek: 'https://api.deepseek.com',
    })
  })
  it('lets a scoped base URL win over the preset and keeps a valid API choice', () => {
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_PROVIDER: 'openai', REVIEW_LLM_BASE_URL: 'https://gw.example.com/v1', REVIEW_LLM_API: 'openai-responses' }))
      .toEqual({ route: 'project', baseUrl: 'https://gw.example.com/v1', api: 'openai-responses', model: 'm' })
  })
  it('needs a base URL for custom', () => {
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_PROVIDER: 'custom' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_BASE_URL'] })
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_PROVIDER: 'custom', REVIEW_LLM_BASE_URL: 'https://x.example.com/v1' }))
      .toEqual({ route: 'project', baseUrl: 'https://x.example.com/v1', api: 'openai-completions', model: 'm' })
  })
  it('names what a key-only route is missing, never falling back to the default', () => {
    expect(decideRoute({ ...key })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_MODEL', 'REVIEW_LLM_PROVIDER or REVIEW_LLM_BASE_URL'] })
  })
  it('rejects LLM settings scoped without a key', () => {
    expect(decideRoute({ REVIEW_LLM_MODEL: 'm' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_API_KEY'] })
  })
  it('rejects a base URL or model GitLab would expand or the settings file could not hold', () => {
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_BASE_URL: 'https://x.example.com/$REVIEW_GITLAB_TOKEN' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_BASE_URL (unsafe value)'] })
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_BASE_URL: 'ftp://x.example.com' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_BASE_URL (unsafe value)'] })
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'gpt $X', REVIEW_LLM_PROVIDER: 'openai' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_MODEL (unsafe value)'] })
  })

  it('is unconfigured when the project requires its own key and has none', () => {
    expect(decideRoute({ REVIEW_REQUIRE_PROJECT_KEY: '1' })).toEqual({ route: 'unconfigured' })
  })
  it('rejects an unknown provider and an unknown API', () => {
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_PROVIDER: 'acme' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_PROVIDER (unknown: acme)'] })
    expect(decideRoute({ ...key, REVIEW_LLM_MODEL: 'm', REVIEW_LLM_PROVIDER: 'openai', REVIEW_LLM_API: 'grpc' })).toEqual({ route: 'invalid', missing: ['REVIEW_LLM_API (unknown: grpc)'] })
  })
})

describe('childPipelineYaml', () => {
  const base = { image: 'ddtcorex/maestro-reviewer:0.14.0', sourceProjectId: 42, mrIid: 7, gitlabHost: 'git.example.com' }
  const job = (text: string) => (parse(text) as Record<string, any>).review

  it('pins identity as literals on a review/<id> environment', () => {
    const j = job(childPipelineYaml({ ...base, route: 'default', deep: false }))
    expect(j.environment).toEqual({ name: 'review/42', action: 'prepare' })
    expect(j.image).toBe('ddtcorex/maestro-reviewer:0.14.0')
    expect(j.variables).toEqual({ GIT_STRATEGY: 'none', SOURCE_PROJECT_ID: '42', MR_IID: '7', GITLAB_HOST: 'git.example.com', REVIEW_ROUTE: 'default' })
    expect(j.resource_group).toBe('review-42-7')
    expect(j.cache.key).toBe('maestro-review-42-7')
    expect(j.script).toEqual(['/entrypoint.sh'])
    expect(JSON.stringify(j.variables)).not.toContain('$')
  })

  it('carries the project route values and the deep request', () => {
    const j = job(childPipelineYaml({ ...base, route: 'project', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', model: 'gpt-x', keySha: '0123456789abcdef', deep: true }))
    expect(j.variables).toMatchObject({ REVIEW_ROUTE: 'project', REVIEW_ROUTE_BASE_URL: 'https://api.openai.com/v1', REVIEW_ROUTE_API: 'openai-completions', REVIEW_ROUTE_MODEL: 'gpt-x', REVIEW_ROUTE_KEY_SHA: '0123456789abcdef', REVIEW_MODE: 'deep', REVIEW_DEEP_REQUESTED: '1' })
  })

  it('keeps reports as artifacts', () => {
    const j = job(childPipelineYaml({ ...base, route: 'default', deep: false }))
    expect(j.artifacts.paths).toEqual(['review-report.json', 'review-report.md', 'gl-code-quality-report.json'])
    expect(j.artifacts.when).toBe('always')
  })
})

describe('noopChildYaml', () => {
  it('is one job on the reviewer image that prints the reason', () => {
    const doc = parse(noopChildYaml('not triggered by a merge request pipeline', 'img:1')) as Record<string, any>
    expect(Object.keys(doc)).toEqual(['skip'])
    expect(doc.skip.image).toEqual({ name: 'img:1', entrypoint: [''] })
    expect(doc.skip.script.join(' ')).toContain('not triggered by a merge request pipeline')
  })
})
