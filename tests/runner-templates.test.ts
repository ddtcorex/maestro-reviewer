import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'

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

  it('reviewer template rules keep when: on its own line', () => {
    const doc = parse(readFileSync('templates/reviewer-project.gitlab-ci.yml', 'utf-8')) as {
      review: { rules: Array<{ if?: string; when?: string }> }
    }
    expect(doc.review.rules).toHaveLength(3)
    expect(doc.review.rules[2]).toEqual({ if: '$CI_PIPELINE_SOURCE == "web"', when: 'manual' })
  })

  it('reviewer template has Protected+Masked hint, no CLI args, and artifacts', () => {
    const yml = readFileSync('templates/reviewer-project.gitlab-ci.yml', 'utf-8')
    expect(yml).toMatch(/MAESTRO_GITLAB_TOKEN/)
    expect(yml).toMatch(/review-report\.json/)
    expect(yml).toMatch(/GIT_STRATEGY: none/)
    expect(yml).toMatch(/script:\s*\n\s*- \/entrypoint\.sh\s*$/m)
    expect(yml).toMatch(/REVIEW_MODEL_PROVIDER/)
    expect(yml).toMatch(/REVIEW_MODEL:/)
    expect(yml).toMatch(/REVIEW_PROFILE/)
    expect(yml).toMatch(/REVIEW_ON_PUSH/)
    expect(yml).toMatch(/cache:\s*\n\s*key: maestro-review-\$SOURCE_PROJECT_ID-\$MR_IID/m)
    expect(yml).toMatch(/\.maestro-history\//)
    // Deep-in-CI recipe: manual run with REVIEW_MODE=deep; the stale
    // "deep stays declined" note must be gone (deep now clones in CI).
    expect(yml).toMatch(/REVIEW_MODE.*deep/s)
    expect(yml).not.toMatch(/stays declined/)
  })

  it('source template uses trigger: project and no secrets', () => {
    const yml = readFileSync('templates/source-project.gitlab-ci.yml', 'utf-8')
    expect(yml).toMatch(/trigger:/)
    expect(yml).toMatch(/SOURCE_PROJECT_ID/)
    expect(yml).toMatch(/REVIEW_PROFILE/)
    expect(yml).toMatch(/REVIEW_ON_PUSH/)
    expect(yml).not.toMatch(/MAESTRO_GITLAB_TOKEN/)
    expect(yml).not.toMatch(/DEEPSEEK_API_KEY/)
  })
})

describe('reviewer template state handling (D2)', () => {
  const doc = () => parse(readFileSync('templates/reviewer-project.gitlab-ci.yml', 'utf-8')) as {
    review: { cache: { key: string; paths: string[] }; resource_group?: string }
  }
  it('keys the history cache per merge request, so concurrent MRs never overwrite each other', () => {
    expect(doc().review.cache.key).toBe('maestro-review-$SOURCE_PROJECT_ID-$MR_IID')
  })
  it('serialises reviews of one merge request with a resource group', () => {
    expect(doc().review.resource_group).toBe('review-$SOURCE_PROJECT_ID-$MR_IID')
  })
  it('documents GitLab, not the cache, as the push-gate source of truth', () => {
    const docs = readFileSync('docs/ci-reviewer-setup.md', 'utf-8')
    expect(docs).toMatch(/newest review comment/i)
    expect(docs).not.toMatch(/History persists across jobs via the `maestro-review-history` cache/)
  })
})
