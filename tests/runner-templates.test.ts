import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'

const reviewerYml = () => readFileSync('templates/reviewer-project.gitlab-ci.yml', 'utf-8')
const sourceYml = () => readFileSync('templates/source-project.gitlab-ci.yml', 'utf-8')

describe('templates', () => {
  // grep-tests cannot catch YAML breakage (proven 2026-09-04: `when: manual`
  // on the same line as `if:` parsed as a nested mapping and produced a
  // jobless downstream pipeline). Both templates must parse as YAML maps.
  it.each([
    ['templates/reviewer-project.gitlab-ci.yml'],
    ['templates/source-project.gitlab-ci.yml'],
  ])('%s parses as a YAML map', (path) => {
    expect(parse(readFileSync(path, 'utf-8'))).toBeTypeOf('object')
  })
})

describe('reviewer template: trusted trigger', () => {
  const doc = () => parse(reviewerYml()) as Record<string, any>

  it('runs resolve, then the child it wrote', () => {
    expect(doc().stages).toEqual(['resolve', 'review'])
  })

  it('resolve runs the resolve command on the reviewer image, bypassing its review entrypoint', () => {
    const r = doc().resolve
    expect(r.stage).toBe('resolve')
    expect(r.image).toEqual({ name: '$REVIEWER_IMAGE', entrypoint: [''] })
    expect(r.script).toEqual(['/resolve.sh'])
    expect(r.environment).toEqual({ name: 'resolve', action: 'prepare' })
    expect(r.artifacts.paths).toEqual(['review-child.yml'])
  })

  it('runs only for bridge triggers', () => {
    expect(doc().resolve.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "pipeline"' }])
    expect(reviewerYml()).not.toMatch(/CI_PIPELINE_SOURCE == "(web|trigger)"/)
  })

  it('triggers the artifact child without forwarding any variable', () => {
    const r = doc().review
    expect(r.stage).toBe('review')
    expect(r.trigger).toEqual({
      include: [{ artifact: 'review-child.yml', job: 'resolve' }],
      strategy: 'depend',
      forward: { yaml_variables: false, pipeline_variables: false },
    })
  })

  it('identity, cache and resource group come from the child, not from variables here', () => {
    const yml = reviewerYml()
    expect(yml).not.toMatch(/\$SOURCE_PROJECT_ID|\$MR_IID/)
    expect(doc().review.cache).toBeUndefined()
  })

  it('documents the restriction, both tokens with their scopes, the scoped variables and the label', () => {
    const yml = reviewerYml()
    for (const s of ['no_one_allowed', 'REVIEW_RESOLVE_TOKEN', 'MAESTRO_GITLAB_TOKEN', 'review/<source project id>', 'REVIEW_LLM_PROVIDER', 'REVIEW_REQUIRE_PROJECT_KEY', 'maestro-review::deep', 'environment scope', 'REVIEW_ALLOWED_NAMESPACES']) {
      expect(yml).toContain(s)
    }
    expect(yml).not.toMatch(/REVIEW_ALLOW_UNRESTRICTED_TRIGGER/)
  })
})

describe('source template: clean bridge', () => {
  const doc = () => parse(sourceYml()) as Record<string, any>
  const bridge = () => Object.values(doc()).find((j: any) => j && typeof j === 'object' && 'trigger' in j) as Record<string, any>

  it('passes and forwards no variable', () => {
    const b = bridge()
    expect(b.variables).toBeUndefined()
    expect(b.inherit).toEqual({ variables: false })
    expect(b.trigger.forward).toEqual({ yaml_variables: false, pipeline_variables: false })
    expect(sourceYml()).not.toMatch(/^\s+SOURCE_PROJECT_ID:/m)
  })

  it('fires on merge request pipelines and holds no secrets', () => {
    expect(bridge().rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }])
    expect(sourceYml()).not.toMatch(/MAESTRO_GITLAB_TOKEN:|DEEPSEEK_API_KEY:|REVIEW_LLM_API_KEY:/)
  })
})
