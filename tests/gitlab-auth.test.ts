import { describe, it, expect, afterEach } from 'vitest'
import { gitlabAuthHeaders } from '../src/host/forge/gitlab/gitlab-auth.js'

describe('gitlabAuthHeaders', () => {
  afterEach(() => { delete process.env.GITLAB_TOKEN_KIND })

  it('uses PRIVATE-TOKEN by default (PAT / project / group tokens)', () => {
    expect(gitlabAuthHeaders('tok')).toEqual({ 'PRIVATE-TOKEN': 'tok' })
  })

  it('uses JOB-TOKEN when GITLAB_TOKEN_KIND=job (CI_JOB_TOKEN via allowlist)', () => {
    process.env.GITLAB_TOKEN_KIND = 'job'
    expect(gitlabAuthHeaders('tok')).toEqual({ 'JOB-TOKEN': 'tok' })
  })

  it('falls back to PRIVATE-TOKEN for unknown kinds', () => {
    process.env.GITLAB_TOKEN_KIND = 'mystery'
    expect(gitlabAuthHeaders('tok')).toEqual({ 'PRIVATE-TOKEN': 'tok' })
  })
})
