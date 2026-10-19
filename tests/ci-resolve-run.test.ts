import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runResolve, UNCONFIGURED_MARKER } from '../src/host/ci-resolve-run.js'

const RESOLVE = 'resolve-tok-SECRET'
const BOT = 'bot-tok-SECRET'
const REVIEWER = 900
const SOURCE = 42
const MR = 7

interface World {
  setting?: string | null
  settingStatus?: number
  upstream?: { id: number; project: number } | null
  ref?: string
  labels?: string[]
  scoped?: Record<string, string>
  scopedStatus?: number
  projectVars?: string[]
  notes?: Array<{ author: { id: number }; body: string }>
}

function gitlab(w: World) {
  const posted: Array<{ url: string; body: unknown }> = []
  const seenTokens: string[] = []
  const fetcher = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const h = new Headers(init.headers)
    const tok = h.get('PRIVATE-TOKEN') ?? ''
    seenTokens.push(`${u.pathname} ${tok}`)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.pathname === '/api/graphql') {
      const up = w.upstream === undefined ? { id: 31, project: SOURCE } : w.upstream
      return json(200, { data: { project: { pipeline: { upstream: up ? { id: `gid://gitlab/Ci::Pipeline/${up.id}`, project: { id: `gid://gitlab/Project/${up.project}` } } : null } } } })
    }
    const p = u.pathname.replace('/api/v4', '')
    if (p === `/projects/${REVIEWER}`) {
      if (tok !== RESOLVE) return json(401, {})
      if (w.settingStatus) return json(w.settingStatus, {})
      return json(200, w.setting === null ? { id: REVIEWER } : { id: REVIEWER, ci_pipeline_variables_minimum_override_role: w.setting ?? 'no_one_allowed' })
    }
    if (p === `/projects/${REVIEWER}/variables`) return tok === RESOLVE ? json(200, (w.projectVars ?? []).map(key => ({ key, environment_scope: '*' }))) : json(403, {})
    const v = /^\/projects\/900\/variables\/([A-Z_]+)$/.exec(p)
    if (v) {
      if (tok !== RESOLVE) return json(403, {})
      if (w.scopedStatus) return json(w.scopedStatus, {})
      expect(u.searchParams.get('filter[environment_scope]')).toBe(`review/${SOURCE}`)
      const value = w.scoped?.[v[1]]
      return value === undefined ? json(404, { message: '404 Variable Not Found' }) : json(200, { key: v[1], value, environment_scope: `review/${SOURCE}` })
    }
    if (p === `/projects/${SOURCE}/pipelines/31`) return json(200, { id: 31, ref: w.ref ?? `refs/merge-requests/${MR}/head` })
    if (p === `/projects/${SOURCE}/merge_requests/${MR}`) return json(200, { iid: MR, labels: w.labels ?? [] })
    if (p === '/user') return json(200, { id: 5 })
    if (p === `/projects/${SOURCE}/merge_requests/${MR}/notes`) {
      if ((init.method ?? 'GET') === 'POST') { posted.push({ url, body: JSON.parse(String(init.body)) }); return json(201, {}) }
      return json(200, w.notes ?? [])
    }
    return json(404, { message: `unexpected ${p}` })
  }
  return { fetcher: fetcher as unknown as typeof fetch, posted, seenTokens }
}

const env = (o: Record<string, string | undefined> = {}) => ({
  CI_PROJECT_ID: String(REVIEWER), CI_PROJECT_PATH: 'ci/reviewer', CI_PIPELINE_ID: '77', CI_PIPELINE_SOURCE: 'pipeline',
  CI_SERVER_HOST: 'git.example.com', CI_SERVER_URL: 'https://git.example.com', CI_PROJECT_DIR: '/builds/ci/reviewer',
  REVIEWER_IMAGE: 'ddtcorex/maestro-reviewer:0.14.0', REVIEW_RESOLVE_TOKEN: RESOLVE, MAESTRO_GITLAB_TOKEN: BOT, ...o,
})

async function run(w: World, e = env()) {
  const g = gitlab(w)
  const files: Record<string, string> = {}
  const logs: string[] = []
  const out = await runResolve(e, { fetcher: g.fetcher, writeFile: async (path, text) => { files[path] = text }, log: (s) => logs.push(s) })
  const child = files['/builds/ci/reviewer/review-child.yml']
  return { ...out, child: child ? parse(child) as Record<string, any> : undefined, raw: Object.values(files).join('\n'), logs, ...g }
}

describe('runResolve', () => {
  it('writes the child from the GitLab identity, ignoring identity variables in env', async () => {
    const r = await run({}, env({ SOURCE_PROJECT_ID: '1', MR_IID: '99', GITLAB_HOST: 'evil.example.com' }))
    expect(r.exitCode).toBe(0)
    expect(r.child?.review.variables).toMatchObject({ SOURCE_PROJECT_ID: '42', MR_IID: '7', GITLAB_HOST: 'git.example.com', REVIEW_ROUTE: 'default' })
    expect(r.child?.review.environment.name).toBe('review/42')
  })

  it('uses the resolve token for reviewer reads and the bot token for source reads', async () => {
    const r = await run({})
    expect(r.seenTokens.filter(s => s.includes('/projects/900')).every(s => s.endsWith(RESOLVE))).toBe(true)
    expect(r.seenTokens.filter(s => s.includes('/projects/42/')).every(s => s.endsWith(BOT))).toBe(true)
  })

  it('writes a no-op child when there is no upstream on a non-bridge run', async () => {
    const r = await run({ upstream: null }, env({ CI_PIPELINE_SOURCE: 'web' }))
    expect(r.exitCode).toBe(0)
    expect(Object.keys(r.child ?? {})).toEqual(['skip'])
  })

  it('fails when a bridge run cannot see its upstream (a permission problem, not a skip)', async () => {
    const r = await run({ upstream: null })
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/Reporter/)
  })

  it('writes a no-op child for an upstream branch pipeline', async () => {
    const r = await run({ ref: 'main' })
    expect(r.exitCode).toBe(0)
    expect(JSON.stringify(r.child)).toMatch(/not a merge request pipeline/)
  })

  it('refuses to run unless pipeline variables are restricted', async () => {
    const r = await run({ setting: 'developer' })
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/no_one_allowed/)
    expect(r.child).toBeUndefined()
  })

  it('has no migration escape hatch: an unrestricted reviewer project always fails', async () => {
    const r = await run({ setting: 'developer' }, env({ REVIEW_ALLOW_UNRESTRICTED_TRIGGER: '1' }))
    expect(r.exitCode).toBe(1)
    expect(r.child).toBeUndefined()
  })

  it('fails closed naming the Maintainer role when the resolve token is missing, weak or unable to see the setting', async () => {
    for (const [w, e] of [[{}, env({ REVIEW_RESOLVE_TOKEN: undefined })], [{ settingStatus: 403 }, env()], [{ setting: null }, env()], [{ scopedStatus: 403 }, env()]] as const) {
      const r = await run(w as World, e)
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toMatch(/Maintainer/)
    }
  })

  it('never writes or logs a token', async () => {
    for (const w of [{}, { setting: 'developer' }, { scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' } }, { scoped: { REVIEW_LLM_API_KEY: 'sk-client-SECRET' } }] as World[]) {
      const r = await run(w)
      const all = `${r.raw}\n${r.logs.join('\n')}\n${JSON.stringify(r.posted)}`
      expect(all).not.toContain('SECRET')
    }
  })

  it('refuses to run when a project variable would shadow a value the child pipeline pins', async () => {
    for (const name of ['REVIEW_ROUTE', 'SOURCE_PROJECT_ID', 'REVIEW_DEEP_REQUESTED', 'REVIEW_ROUTE_KEY_SHA']) {
      const r = await run({ projectVars: ['DEEPSEEK_API_KEY', name] })
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toContain(name)
    }
  })

  it('asks for deep when the MR carries the label', async () => {
    const r = await run({ labels: ['bug', 'maestro-review::deep'] })
    expect(r.child?.review.variables).toMatchObject({ REVIEW_MODE: 'deep', REVIEW_DEEP_REQUESTED: '1' })
  })

  it('routes to the project provider when the scope is complete', async () => {
    const r = await run({ scoped: { REVIEW_LLM_API_KEY: 'sk-client-SECRET', REVIEW_LLM_MODEL: 'gpt-x', REVIEW_LLM_PROVIDER: 'openai' } })
    expect(r.child?.review.variables).toMatchObject({ REVIEW_ROUTE: 'project', REVIEW_ROUTE_BASE_URL: 'https://api.openai.com/v1', REVIEW_ROUTE_API: 'openai-completions' })
  })

  it('fails closed on an incomplete project scope, naming the missing variables', async () => {
    const r = await run({ scoped: { REVIEW_LLM_API_KEY: 'sk-client-SECRET' } })
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/REVIEW_LLM_MODEL/)
  })

  it('posts the unconfigured note once and writes a no-op child', async () => {
    const first = await run({ scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' } })
    expect(first.exitCode).toBe(0)
    expect(first.posted).toHaveLength(1)
    expect(JSON.stringify(first.posted[0].body)).toContain(UNCONFIGURED_MARKER)
    expect(Object.keys(first.child ?? {})).toEqual(['skip'])
    const again = await run({ scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' }, notes: [{ author: { id: 5 }, body: `x ${UNCONFIGURED_MARKER}` }] })
    expect(again.posted).toHaveLength(0)
  })
})
