import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runResolve, UNCONFIGURED_MARKER } from '../src/host/ci-resolve-run.js'

const RESOLVE = 'resolve-tok-SECRET'
const BOT = 'bot-tok-SECRET'
const REVIEWER = 900
const CONFIG = 901
const SOURCE = 42
const MR = 7

interface World {
  setting?: string | null
  settingStatus?: number
  upstream?: { id: number; project: number; path?: string } | null
  ref?: string
  labels?: string[]
  scoped?: Record<string, string>
  scopedStatus?: number
  projectVars?: string[]
  protection?: Record<string, unknown> | null
  configPath?: string | null
  configStatus?: number
  configProject?: Record<string, unknown>
  protectionRef?: string
  protections?: Array<Record<string, unknown>>
  me?: Record<string, unknown>
  memberLevels?: Record<string, number>
  repoFileStatus?: number
  notes?: Array<{ author: { id: number }; body: string }>
  notesPages?: Array<Array<{ author: { id: number }; body: string }>>
  noteStatus?: number
  notesListStatus?: number
  scopedVars?: Array<{ key: string; scope: string }>
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
      const up = w.upstream === undefined ? { id: 31, project: SOURCE, path: 'clients/acme/shop' } : w.upstream
      return json(200, { data: { project: { pipeline: { upstream: up ? { id: `gid://gitlab/Ci::Pipeline/${up.id}`, project: { id: `gid://gitlab/Project/${up.project}`, fullPath: up.path ?? 'clients/acme/shop' } } : null } } } })
    }
    const p = u.pathname.replace('/api/v4', '')
    if (p === `/projects/${REVIEWER}`) {
      if (tok !== RESOLVE) return json(401, {})
      if (w.settingStatus) return json(w.settingStatus, {})
      const ci_config_path = w.configPath === undefined ? 'maestro-reviewer.yml@ci/reviewer-config' : w.configPath
      return json(200, w.setting === null ? { id: REVIEWER, ci_config_path } : { id: REVIEWER, ci_config_path, ci_pipeline_variables_minimum_override_role: w.setting ?? 'no_one_allowed' })
    }
    if (p === `/projects/${encodeURIComponent('ci/reviewer-config')}`) {
      if (tok !== BOT) return json(404, {})
      if (w.configStatus) return json(w.configStatus, {})
      return json(200, w.configProject ?? { id: CONFIG, default_branch: 'main', permissions: { project_access: { access_level: 20 }, group_access: null } })
    }
    if (p === `/projects/${CONFIG}/protected_branches`) {
      if (tok !== BOT) return json(403, {})
      if (w.protections) return json(200, w.protections)
      if (w.protection === null) return json(200, [])
      return json(200, [{ name: w.protectionRef ?? 'main', ...(w.protection ?? { allow_force_push: false, push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }] }) }])
    }
    const mem = /^\/projects\/(\d+)\/members\/all\/5$/.exec(p)
    if (mem) {
      if (tok !== BOT) return json(403, {})
      const lvl = w.memberLevels?.[mem[1]] ?? (mem[1] === String(CONFIG) ? 20 : 20)
      return lvl === 0 ? json(404, {}) : json(200, { id: 5, access_level: lvl })
    }
    if (p.startsWith(`/projects/${REVIEWER}/repository/files/`)) {
      if (tok !== RESOLVE) return json(403, {})
      expect(u.searchParams.get('ref')).toBe('c0ffee')
      return json(w.repoFileStatus ?? 404, {})
    }
    if (p === `/projects/${REVIEWER}/variables`) {
      if (tok !== RESOLVE) return json(403, {})
      return json(200, [...(w.projectVars ?? []).map(key => ({ key, environment_scope: '*' })), ...(w.scopedVars ?? []).map(v => ({ key: v.key, environment_scope: v.scope }))])
    }
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
    if (p === '/user') return json(200, w.me ?? { id: 5, username: 'bot' })
    if (p === `/projects/${SOURCE}/merge_requests/${MR}/notes`) {
      if ((init.method ?? 'GET') === 'POST') { posted.push({ url, body: JSON.parse(String(init.body)) }); return json(w.noteStatus ?? 201, {}) }
      if (w.notesListStatus) return json(w.notesListStatus, {})
      if (w.notesPages) {
        const page = Number(u.searchParams.get('page') ?? '1')
        const res = json(200, w.notesPages[page - 1] ?? [])
        if (page < w.notesPages.length) res.headers.set('x-next-page', String(page + 1))
        return res
      }
      return json(200, w.notes ?? [])
    }
    return json(404, { message: `unexpected ${p}` })
  }
  return { fetcher: fetcher as unknown as typeof fetch, posted, seenTokens }
}

const env = (o: Record<string, string | undefined> = {}) => ({
  CI_PROJECT_ID: String(REVIEWER), CI_PROJECT_PATH: 'ci/reviewer', CI_COMMIT_REF_NAME: 'main', CI_COMMIT_SHA: 'c0ffee', CI_PIPELINE_ID: '77', CI_PIPELINE_SOURCE: 'pipeline',
  CI_SERVER_HOST: 'git.example.com', CI_SERVER_URL: 'https://git.example.com', CI_PROJECT_DIR: '/builds/ci/reviewer',
  REVIEWER_IMAGE: 'ddtcorex/maestro-reviewer:0.14.0', REVIEW_RESOLVE_TOKEN: RESOLVE, REVIEW_GITLAB_TOKEN: BOT,
  REVIEW_ALLOWED_NAMESPACES: 'internal/, clients/acme', ...o,
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
    expect(r.seenTokens.filter(s => s.includes('/projects/900') && !s.includes('/members/all/')).every(s => s.endsWith(RESOLVE))).toBe(true)
    // The bot reads only its own role there, never settings or variables.
    expect(r.seenTokens.filter(s => s.includes('/projects/900') && s.endsWith(BOT)).every(s => s.includes('/members/all/'))).toBe(true)
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

  it('fails naming REVIEW_GITLAB_TOKEN when only the pre-0.15 name is set', async () => {
    const r = await run({}, env({ REVIEW_GITLAB_TOKEN: undefined, MAESTRO_GITLAB_TOKEN: BOT }))
    expect(r.exitCode).not.toBe(0)
    expect(r.logs.join('\n')).toMatch(/missing REVIEW_GITLAB_TOKEN/)
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

  it('refuses to run unless the pipeline file lives in a separate project', async () => {
    for (const configPath of [null, '', '.gitlab-ci.yml', 'maestro-reviewer.yml', 'maestro-reviewer.yml@ci/reviewer', 'maestro-reviewer.yml@CI/Reviewer']) {
      const r = await run({ configPath })
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toMatch(/CI config path/)
      expect(r.child).toBeUndefined()
    }
  })

  it('refuses to run when the config project resolves to the reviewer project itself', async () => {
    const r = await run({ configProject: { id: REVIEWER, default_branch: 'main', permissions: { project_access: { access_level: 20 } } } })
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/separate/)
  })

  it('fails naming Reporter when the bot cannot read the config project', async () => {
    for (const configStatus of [403, 404]) {
      const r = await run({ configStatus })
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toMatch(/REVIEW_GITLAB_TOKEN.*Reporter/)
    }
  })

  it('refuses to run when the bot could change the config project', async () => {
    for (const permissions of [{ project_access: { access_level: 30 } }, { project_access: { access_level: 40 } }, { project_access: null, group_access: { access_level: 50 } }]) {
      const r = await run({ configProject: { id: CONFIG, default_branch: 'main', permissions } })
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toMatch(/Reporter/)
    }
  })

  it('refuses to run unless the config branch only lets Maintainers change it', async () => {
    const lv = (n: number) => [{ access_level: n }]
    for (const protection of [
      null,
      { allow_force_push: false, push_access_levels: lv(40), merge_access_levels: lv(30) },
      { allow_force_push: false, push_access_levels: lv(30), merge_access_levels: lv(40) },
      { allow_force_push: true, push_access_levels: lv(40), merge_access_levels: lv(40) },
      { allow_force_push: false, push_access_levels: [{ access_level: 40 }, { user_id: 9, access_level: null }], merge_access_levels: lv(40) },
    ]) {
      const r = await run({ protection })
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toMatch(/protect/)
      expect(r.child).toBeUndefined()
    }
    expect((await run({ protection: { allow_force_push: false, push_access_levels: lv(0), merge_access_levels: lv(40) } })).exitCode).toBe(0)
  })

  it('checks the explicit ref of the config path, not the default branch', async () => {
    expect((await run({ configPath: 'maestro-reviewer.yml@ci/reviewer-config:stable', protectionRef: 'stable' })).exitCode).toBe(0)
    const tag = await run({ configPath: 'maestro-reviewer.yml@ci/reviewer-config:v1.0.0', protectionRef: 'main' })
    expect(tag.exitCode).toBe(1)
    expect(tag.logs.join('\n')).toMatch(/v1\.0\.0.*not protected/)
  })

  it('applies every protection rule that matches the config branch, wildcards included', async () => {
    const lv = (n: number) => [{ access_level: n }]
    const strict = { allow_force_push: false, push_access_levels: lv(40), merge_access_levels: lv(40) }
    const loose = { allow_force_push: false, push_access_levels: lv(30), merge_access_levels: lv(30) }
    for (const wildcard of ['*', 'ma*', '*n']) {
      const r = await run({ protections: [{ name: 'main', ...strict }, { name: wildcard, ...loose }] })
      expect(r.exitCode, wildcard).toBe(1)
      expect(r.logs.join('\n')).toMatch(/Maintainers only/)
    }
    expect((await run({ protections: [{ name: 'main', ...strict }, { name: 'release/*', ...loose }] })).exitCode).toBe(0)
    expect((await run({ protections: [{ name: 'ma*', ...strict }] })).exitCode).toBe(0)
  })

  it('fails closed on a protection rule with missing or empty fields, and on an empty ref', async () => {
    for (const rule of [
      { name: 'main', allow_force_push: false, push_access_levels: [], merge_access_levels: [{ access_level: 40 }] },
      { name: 'main', allow_force_push: false, merge_access_levels: [{ access_level: 40 }] },
      { name: 'main', push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }] },
    ]) {
      expect((await run({ protections: [rule] })).exitCode).toBe(1)
    }
    const noBranch = await run({ configProject: { id: CONFIG, default_branch: null, permissions: { project_access: { access_level: 20 } } } })
    expect(noBranch.exitCode).toBe(1)
    expect(noBranch.logs.join('\n')).toMatch(/branch/)
  })

  it('refuses when the reviewer repository holds a file at the literal CI config path, and fails closed when it cannot tell', async () => {
    const shadow = await run({ repoFileStatus: 200 })
    expect(shadow.exitCode).toBe(1)
    expect(shadow.logs.join('\n')).toMatch(/reviewer repository/)
    expect((await run({ repoFileStatus: 403 })).exitCode).toBe(1)
  })

  it('counts access the bot holds through shared groups, and refuses an admin bot', async () => {
    const shared = await run({ memberLevels: { [CONFIG]: 30 } })
    expect(shared.exitCode).toBe(1)
    expect(shared.logs.join('\n')).toMatch(/config project.*Reporter/)
    const admin = await run({ me: { id: 5, username: 'bot', is_admin: true } })
    expect(admin.exitCode).toBe(1)
    expect(admin.logs.join('\n')).toMatch(/administrator/)
  })

  it('refuses a bot that is Maintainer on the reviewer project, which can read every key', async () => {
    const r = await run({ memberLevels: { [REVIEWER]: 40 } })
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/reviewer project/)
  })

  it('with REVIEW_ACCEPT_PRIVILEGED_BOT=1 only warns about an over-privileged bot, and still refuses an admin', async () => {
    const levels = { [CONFIG]: 40, [REVIEWER]: 40 }
    const accepted = await run({ memberLevels: levels }, env({ REVIEW_ACCEPT_PRIVILEGED_BOT: '1' }))
    expect(accepted.exitCode).toBe(0)
    expect(accepted.child?.review).toBeDefined()
    const log = accepted.logs.join('\n')
    expect(log).toMatch(/warning.*config project.*REVIEW_ACCEPT_PRIVILEGED_BOT/)
    expect(log).toMatch(/warning.*reviewer project.*REVIEW_ACCEPT_PRIVILEGED_BOT/)
    for (const value of ['0', 'true', 'yes', '']) {
      expect((await run({ memberLevels: levels }, env({ REVIEW_ACCEPT_PRIVILEGED_BOT: value }))).exitCode, value).toBe(1)
    }
    const admin = await run({ me: { id: 5, username: 'bot', is_admin: true } }, env({ REVIEW_ACCEPT_PRIVILEGED_BOT: '1' }))
    expect(admin.exitCode).toBe(1)
  })

  it('no longer requires the reviewer branch itself to be Maintainers only', async () => {
    const r = await run({})
    expect(r.exitCode).toBe(0)
    expect(r.seenTokens.some(t => t.includes(`/projects/${REVIEWER}/protected_branches`))).toBe(false)
  })

  it('refuses to run without an allowlist of source namespaces', async () => {
    for (const value of [undefined, '', ' , ']) {
      const r = await run({}, env({ REVIEW_ALLOWED_NAMESPACES: value }))
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toMatch(/REVIEW_ALLOWED_NAMESPACES/)
    }
  })

  it('reviews nothing for a project outside the allowlist, and posts nothing there', async () => {
    for (const path of ['someone/personal', 'clients/acme-other/shop', 'internalx/tool']) {
      const r = await run({ upstream: { id: 31, project: SOURCE, path }, scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' } })
      expect(r.exitCode).toBe(0)
      expect(Object.keys(r.child ?? {})).toEqual(['skip'])
      expect(r.posted).toHaveLength(0)
      expect(r.logs.join('\n')).toContain(path)
    }
  })

  it('matches an allowlist entry as a whole path segment prefix or as an exact project', async () => {
    for (const path of ['clients/acme', 'clients/acme/shop', 'internal/tools/ci']) {
      const r = await run({ upstream: { id: 31, project: SOURCE, path } })
      expect(r.child?.review).toBeDefined()
    }
  })

  it('asks for deep when the MR carries the label', async () => {
    const r = await run({ labels: ['bug', 'maestro-review::deep'] })
    expect(r.child?.review.variables).toMatchObject({ REVIEW_MODE: 'deep', REVIEW_DEEP_REQUESTED: '1' })
  })

  it('routes to the project provider when the scope is complete', async () => {
    const r = await run({ scoped: { REVIEW_LLM_API_KEY: 'sk-client-SECRET', REVIEW_LLM_MODEL: 'gpt-x', REVIEW_LLM_PROVIDER: 'openai' } })
    expect(r.child?.review.variables).toMatchObject({ REVIEW_ROUTE: 'project', REVIEW_ROUTE_BASE_URL: 'https://api.openai.com/v1', REVIEW_ROUTE_API: 'openai-completions', REVIEW_ROUTE_MODEL: 'gpt-x' })
    const { createHash } = await import('node:crypto')
    expect(r.child?.review.variables.REVIEW_ROUTE_KEY_SHA).toBe(createHash('sha256').update('sk-client-SECRET').digest('hex').slice(0, 16))
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

  it('refuses a provider or mode variable at a wildcard scope other than *, which would reach every matching project', async () => {
    for (const [key, scope] of [['REVIEW_LLM_API_KEY', 'review/*'], ['REVIEW_MODE', 'review/1*'], ['REVIEW_REQUIRE_PROJECT_KEY', '*/42'], ['REVIEW_ON_PUSH', 'review/*'], ['REVIEW_PROFILE', 'review/*']]) {
      const r = await run({ scopedVars: [{ key, scope }] })
      expect(r.exitCode).toBe(1)
      expect(r.logs.join('\n')).toContain(key)
      expect(r.logs.join('\n')).toContain(scope)
      expect(r.child).toBeUndefined()
    }
  })

  it('accepts those variables at exactly * or at an exact review scope, and ignores wildcards on unrelated names', async () => {
    const r = await run({ scopedVars: [{ key: 'REVIEW_MODE', scope: '*' }, { key: 'REVIEW_LLM_MODEL', scope: 'review/7' }, { key: 'TELEGRAM_CHAT_ID', scope: 'review/*' }] })
    expect(r.exitCode).toBe(0)
  })

  it('still writes the no-op child when posting the unconfigured note fails, and says so', async () => {
    const r = await run({ scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' }, noteStatus: 500 })
    expect(r.exitCode).toBe(0)
    expect(Object.keys(r.child ?? {})).toEqual(['skip'])
    expect(r.logs.join('\n')).toMatch(/could not post the unconfigured note \(500\)/)
  })

  it('finds an earlier unconfigured note beyond the first page of notes', async () => {
    const other = Array.from({ length: 100 }, (_, i) => ({ author: { id: 8 }, body: `comment ${i}` }))
    const r = await run({ scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' }, notesPages: [other, [{ author: { id: 5 }, body: `x ${UNCONFIGURED_MARKER}` }]] })
    expect(r.posted).toHaveLength(0)
  })

  it('honours REVIEW_REQUIRE_PROJECT_KEY set for every project (scope *), unless a project scope says otherwise', async () => {
    const all = await run({}, env({ REVIEW_REQUIRE_PROJECT_KEY: '1' }))
    expect(Object.keys(all.child ?? {})).toEqual(['skip'])
    expect(all.posted).toHaveLength(1)
    const optedOut = await run({ scoped: { REVIEW_REQUIRE_PROJECT_KEY: '0' } }, env({ REVIEW_REQUIRE_PROJECT_KEY: '1' }))
    expect(optedOut.child?.review.variables).toMatchObject({ REVIEW_ROUTE: 'default' })
  })

  it('does not post the unconfigured note when the notes cannot be listed, so a retry cannot post it twice', async () => {
    const r = await run({ scoped: { REVIEW_REQUIRE_PROJECT_KEY: '1' }, notesListStatus: 500 })
    expect(r.exitCode).toBe(0)
    expect(Object.keys(r.child ?? {})).toEqual(['skip'])
    expect(r.posted).toHaveLength(0)
    expect(r.logs.join('\n')).toMatch(/could not list the MR notes \(500\)/)
  })
})
