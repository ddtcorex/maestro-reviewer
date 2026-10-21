import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const BAKED = '# __CI_MANAGED__\nproviders: deepseek-official\n'

/** Runs select_route from docker/route.sh against temp copies of the settings files. */
function route(env: Record<string, string>, settings = BAKED) {
  const dir = mkdtempSync(join(tmpdir(), 'route-'))
  const target = join(dir, 'settings.yaml')
  const generic = join(dir, 'settings.generic-openai.yaml')
  writeFileSync(target, settings)
  writeFileSync(generic, readFileSync('docker/ci-settings.generic-openai.yaml', 'utf-8'))
  const r = spawnSync('sh', ['-c', '. docker/route.sh; select_route "$1" "$2"; rc=$?; echo "PIN=${REVIEW_MODEL_PROVIDER:-}/${REVIEW_MODEL:-}"; echo "DEEP=${REVIEW_DEEP_MODEL_PROVIDER:-}/${REVIEW_DEEP_MODEL:-}"; exit $rc', 'sh', target, generic], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CI_JOB_ID: '123', ...env }, encoding: 'utf-8',
  })
  return { code: r.status, out: readFileSync(target, 'utf-8'), stderr: r.stderr + r.stdout }
}

const triple = { REVIEW_LLM_API_KEY: 'k', REVIEW_LLM_BASE_URL: 'https://default.example.com/v1', REVIEW_LLM_MODEL: 'default-model' }
const sha = (k: string) => createHash('sha256').update(k).digest('hex').slice(0, 16)
const projectRoute = (key = 'pk') => ({ REVIEW_ROUTE: 'project', REVIEW_ROUTE_BASE_URL: 'https://api.openai.com/v1', REVIEW_ROUTE_API: 'openai-completions', REVIEW_ROUTE_MODEL: 'project-model', REVIEW_ROUTE_KEY_SHA: sha(key), REVIEW_LLM_API_KEY: key })

describe('select_route', () => {
  it('keeps the baked default without a route or key', () => {
    const r = route({})
    expect(r.code).toBe(0)
    expect(r.out).toBe(BAKED)
  })

  it('without a route, overlays the bring-your-own triple exactly as before', () => {
    const r = route(triple)
    expect(r.code).toBe(0)
    expect(r.out).toContain('baseURL: https://default.example.com/v1')
    expect(r.out).toContain('default-model')
    expect(r.out).not.toContain('__REVIEW_LLM_')
  })

  it('the default route behaves like no route', () => {
    expect(route({ ...triple, REVIEW_ROUTE: 'default' }).out).toBe(route(triple).out)
  })

  it('the project route takes its base URL and API from the resolve job, never from an inherited variable', () => {
    const r = route({ ...triple, REVIEW_LLM_API: 'openai-completions', ...projectRoute('k'), REVIEW_ROUTE_API: 'openai-responses' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('baseURL: https://api.openai.com/v1')
    expect(r.out).not.toContain('default.example.com')
    expect(r.out).toContain('api: openai-responses')
    expect(r.out).toContain('project-model')
  })

  it('the project route fails closed without its key, pinned model, key hash or base URL', () => {
    const base = projectRoute('k')
    for (const drop of ['REVIEW_LLM_API_KEY', 'REVIEW_ROUTE_MODEL', 'REVIEW_ROUTE_KEY_SHA', 'REVIEW_ROUTE_BASE_URL'] as const) {
      const env: Record<string, string> = { ...base }
      delete env[drop]
      const r = route(env)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain(drop)
      expect(r.out).toBe(BAKED)
    }
  })

  it('the project route refuses a key that changed since resolve (a deleted scoped key falls back to the default one)', () => {
    const r = route({ ...projectRoute('client-key'), REVIEW_LLM_API_KEY: 'default-key' })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/changed since resolve/)
    expect(r.out).toBe(BAKED)
  })

  it('a project route drops the default-scope model pin, so the project key never runs a model the project did not choose', () => {
    const pin = { REVIEW_MODEL_PROVIDER: 'custom-openai', REVIEW_MODEL: 'default-pinned' }
    const project = route({ ...pin, ...projectRoute('k'), REVIEW_LLM_MODEL: 'inherited-model' })
    expect(project.out).toContain('project-model')
    expect(project.out).not.toContain('inherited-model')
    expect(project.code).toBe(0)
    expect(project.stderr).toContain('PIN=/')
    const fallback = route({ ...pin, ...triple })
    expect(fallback.stderr).toContain('PIN=custom-openai/default-pinned')
  })

  it('a project route also drops the default-scope deep model pair used for fan-out parts', () => {
    const deep = { REVIEW_DEEP_MODEL_PROVIDER: 'deepseek-official', REVIEW_DEEP_MODEL: 'deepseek-v4-pro' }
    expect(route({ ...deep, ...projectRoute('k') }).stderr).toContain('DEEP=/')
    expect(route({ ...deep, ...triple }).stderr).toContain('DEEP=deepseek-official/deepseek-v4-pro')
  })

  it('unconfigured returns 3 so the entrypoint exits without a review', () => {
    const r = route({ REVIEW_ROUTE: 'unconfigured' })
    expect(r.code).toBe(3)
    expect(r.out).toBe(BAKED)
  })

  it('rejects an unknown route', () => {
    expect(route({ REVIEW_ROUTE: 'other' }).code).toBe(1)
  })

  it('leaves a job-mounted settings file alone, even on the project route', () => {
    const mounted = 'providers: mine\n'
    const r = route(projectRoute('k'), mounted)
    expect(r.code).toBe(0)
    expect(r.out).toBe(mounted)
  })

  it('unconfigured returns 3 even with a job-mounted settings file', () => {
    const mounted = 'providers: mine\n'
    const r = route({ REVIEW_ROUTE: 'unconfigured' }, mounted)
    expect(r.code).toBe(3)
    expect(r.out).toBe(mounted)
  })

  it('the entrypoint sources route.sh and exits 0 on an unconfigured route', () => {
    const sh = readFileSync('docker/entrypoint.sh', 'utf-8')
    expect(sh).toMatch(/\. \/route\.sh/)
    expect(sh).toMatch(/select_route \/app\/settings\.yaml \/app\/settings\.generic-openai\.yaml/)
    expect(readFileSync('docker/Dockerfile', 'utf-8')).toMatch(/COPY docker\/route\.sh \/route\.sh/)
  })
})
