import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gitlabAuthHeaders } from './forge/gitlab/gitlab-auth.js'
import { fetchBotUserId } from './ci-coexist.js'
import { childPipelineYaml, decideRoute, namespaceAllowed, noopChildYaml, parseAllowedNamespaces, parseMrRef, SCOPED_LLM_NAMES, type ScopedLlm } from './ci-resolve.js'

/**
 * The resolve job of the reviewer pipeline (spec 3.2). Under the
 * `no_one_allowed` pipeline-variables restriction its environment is
 * trustworthy, so it asks GitLab which MR triggered it instead of believing
 * trigger variables, decides the provider route, and writes the child
 * pipeline. Reviewer-project reads use REVIEW_RESOLVE_TOKEN (Maintainer, scoped
 * to the `resolve` environment so the review job never receives it); source
 * reads use REVIEW_GITLAB_TOKEN. Tokens are never logged or written.
 */

export const DEEP_LABEL = 'maestro-review::deep'
export const UNCONFIGURED_MARKER = '<!-- maestro-review-unconfigured -->'
const CHILD_FILE = 'review-child.yml'
/**
 * Values the child pipeline pins as job variables. GitLab ranks project CI
 * variables above `.gitlab-ci.yml` ones, so a project variable of the same
 * name (at any scope) would silently replace them.
 */
export const PINNED_CHILD_NAMES = ['SOURCE_PROJECT_ID', 'MR_IID', 'GITLAB_HOST', 'REVIEW_ROUTE', 'REVIEW_ROUTE_BASE_URL', 'REVIEW_ROUTE_API', 'REVIEW_ROUTE_MODEL', 'REVIEW_ROUTE_KEY_SHA', 'REVIEW_DEEP_REQUESTED'] as const
/**
 * Variables whose value must belong to one project or to all of them. A
 * wildcard scope such as `review/*` matches every review/<id> environment, so
 * one project's key or mode would silently reach all the others.
 */
const PER_PROJECT_NAMES: readonly string[] = [...SCOPED_LLM_NAMES, 'REVIEW_MODE', 'REVIEW_PROFILE', 'REVIEW_ON_PUSH']
const NOTE_PAGES = 20
const MAINTAINER_HINT = 'REVIEW_RESOLVE_TOKEN must be a Maintainer token (read_api) on the reviewer project, stored masked with environment scope "resolve"'

export interface ResolveDeps {
  fetcher: typeof fetch
  writeFile: (path: string, text: string) => Promise<void>
  log: (line: string) => void
}

class ResolveError extends Error {}

const gid = (s: string | undefined): number | undefined => {
  const m = /\/(\d+)$/.exec(s ?? '')
  return m ? Number(m[1]) : undefined
}

export async function runResolve(env: Record<string, string | undefined>, deps: ResolveDeps): Promise<{ exitCode: number; childPath: string }> {
  const childPath = join(env.CI_PROJECT_DIR ?? '.', CHILD_FILE)
  const write = (text: string) => deps.writeFile(childPath, text)
  try {
    const need = (name: string) => {
      const v = env[name]
      if (v === undefined || v === '') throw new ResolveError(name === 'REVIEW_RESOLVE_TOKEN' ? `missing REVIEW_RESOLVE_TOKEN: ${MAINTAINER_HINT}` : `missing ${name}`)
      return v
    }
    const reviewerId = need('CI_PROJECT_ID')
    const host = need('CI_SERVER_HOST')
    const image = need('REVIEWER_IMAGE')
    const resolveToken = need('REVIEW_RESOLVE_TOKEN')
    const botToken = need('REVIEW_GITLAB_TOKEN')
    // Only allowlisted namespaces may spend the reviewer's keys or expose its
    // bot token to an agent reading their content.
    const allowed = parseAllowedNamespaces(env.REVIEW_ALLOWED_NAMESPACES)
    if (allowed.length === 0) throw new ResolveError('REVIEW_ALLOWED_NAMESPACES is not set: list the groups or projects allowed to use this reviewer, comma separated (for example "my-group/, other-group/app")')
    const server = env.CI_SERVER_URL ?? `https://${host}`
    const api = `${server}/api/v4`
    const get = async (token: string, path: string) => deps.fetcher(`${api}${path}`, { headers: gitlabAuthHeaders(token) })

    // 1. Guardrail: the job is only trustworthy when trigger variables are forbidden.
    const projectRes = await get(resolveToken, `/projects/${reviewerId}`)
    const project = projectRes.ok ? await projectRes.json() as { ci_pipeline_variables_minimum_override_role?: string } : undefined
    const setting = project?.ci_pipeline_variables_minimum_override_role
    if (setting === undefined) throw new ResolveError(`cannot read the reviewer project's pipeline-variables setting (GET project -> ${projectRes.status}): ${MAINTAINER_HINT}`)
    if (setting !== 'no_one_allowed') {
      throw new ResolveError(`pipeline variables are not restricted on the reviewer project (minimum override role "${setting}"); set it to no_one_allowed (Settings > CI/CD > Variables) before any review can run`)
    }

    // The pipeline file and the protected variables are only as safe as the
    // branch they run from: anyone who can push or merge there can read every key.
    const pipelineRef = need('CI_COMMIT_REF_NAME')
    const protRes = await get(resolveToken, `/projects/${reviewerId}/protected_branches/${encodeURIComponent(pipelineRef)}`)
    if (protRes.status === 404) throw new ResolveError(`branch ${pipelineRef} of the reviewer project is not protected; protect it with push and merge for Maintainers only`)
    if (!protRes.ok) throw new ResolveError(`cannot read the protection of branch ${pipelineRef} (${protRes.status}): ${MAINTAINER_HINT}`)
    type Level = { access_level?: number | null; user_id?: number | null; group_id?: number | null; deploy_key_id?: number | null }
    const prot = await protRes.json() as { allow_force_push?: boolean; push_access_levels?: Level[]; merge_access_levels?: Level[] }
    const maintainersOnly = (levels: Level[] | undefined) => (levels ?? []).every(l =>
      l.user_id == null && l.group_id == null && l.deploy_key_id == null && typeof l.access_level === 'number' && (l.access_level === 0 || l.access_level >= 40))
    if (prot.allow_force_push === true || !maintainersOnly(prot.push_access_levels) || !maintainersOnly(prot.merge_access_levels)) {
      throw new ResolveError(`branch ${pipelineRef} of the reviewer project must be protected for Maintainers only (push and merge), with force push off and no per-user or per-group grants`)
    }

    const shadowing = new Set<string>()
    const wildcards = new Set<string>()
    let page = '1'
    for (let n = 0; page && n < 20; n++) {
      const res = await get(resolveToken, `/projects/${reviewerId}/variables?per_page=100&page=${page}`)
      if (!res.ok) throw new ResolveError(`cannot list the reviewer project's variables (${res.status}): ${MAINTAINER_HINT}`)
      for (const v of await res.json() as Array<{ key?: string; environment_scope?: string }>) {
        if (v.key === undefined) continue
        if ((PINNED_CHILD_NAMES as readonly string[]).includes(v.key)) shadowing.add(v.key)
        const scope = v.environment_scope ?? '*'
        if (PER_PROJECT_NAMES.includes(v.key) && scope !== '*' && scope.includes('*')) wildcards.add(`${v.key} (scope ${scope})`)
      }
      page = res.headers.get('x-next-page') ?? ''
    }
    if (shadowing.size > 0) {
      throw new ResolveError(`project variable(s) ${[...shadowing].join(', ')} would override what the child pipeline pins; delete them from the reviewer project`)
    }
    if (wildcards.size > 0) {
      throw new ResolveError(`variable(s) ${[...wildcards].join(', ')} use a wildcard environment scope, which reaches every matching project; scope them to exactly * or to one review/<source project id>`)
    }

    // 2. Who triggered this pipeline, asked of GitLab rather than of variables.
    const query = `{ project(fullPath: ${JSON.stringify(need('CI_PROJECT_PATH'))}) { pipeline(id: ${JSON.stringify(`gid://gitlab/Ci::Pipeline/${need('CI_PIPELINE_ID')}`)}) { upstream { id project { id fullPath } } } } }`
    const gq = await deps.fetcher(`${server}/api/graphql`, { method: 'POST', headers: { ...gitlabAuthHeaders(botToken), 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
    const upstream = gq.ok ? (await gq.json() as { data?: { project?: { pipeline?: { upstream?: { id?: string; project?: { id?: string; fullPath?: string } } | null } } } }).data?.project?.pipeline?.upstream : undefined
    const upstreamId = gid(upstream?.id)
    const sourceId = gid(upstream?.project?.id)
    if (upstreamId === undefined || sourceId === undefined) {
      if (env.CI_PIPELINE_SOURCE === 'pipeline') {
        throw new ResolveError('this pipeline was triggered by another one, but its upstream is not visible: REVIEW_GITLAB_TOKEN needs at least Reporter on the reviewer project and on the source project')
      }
      deps.log('[review] not triggered by a source pipeline, nothing to review')
      await write(noopChildYaml('not triggered by a source pipeline, nothing to review', image))
      return { exitCode: 0, childPath }
    }

    const sourcePath = upstream?.project?.fullPath ?? ''
    if (!namespaceAllowed(sourcePath, allowed)) {
      deps.log(`[review] project ${sourcePath || sourceId} is not in REVIEW_ALLOWED_NAMESPACES; not reviewing`)
      await write(noopChildYaml(`project ${sourcePath || sourceId} is not allowed to use this reviewer`, image))
      return { exitCode: 0, childPath }
    }

    const pipeRes = await get(botToken, `/projects/${sourceId}/pipelines/${upstreamId}`)
    if (!pipeRes.ok) throw new ResolveError(`cannot read upstream pipeline ${upstreamId} of project ${sourceId} (${pipeRes.status}): REVIEW_GITLAB_TOKEN needs at least Reporter on the source project`)
    const ref = (await pipeRes.json() as { ref?: string }).ref ?? ''
    const mrIid = parseMrRef(ref)
    if (mrIid === undefined) {
      deps.log(`[review] upstream pipeline ${upstreamId} (ref ${ref}) is not a merge request pipeline, nothing to review`)
      await write(noopChildYaml('upstream pipeline is not a merge request pipeline, nothing to review', image))
      return { exitCode: 0, childPath }
    }
    const mrRes = await get(botToken, `/projects/${sourceId}/merge_requests/${mrIid}`)
    if (!mrRes.ok) throw new ResolveError(`cannot read MR !${mrIid} of project ${sourceId} (${mrRes.status})`)
    const labels = (await mrRes.json() as { labels?: string[] }).labels ?? []
    const deep = labels.includes(DEEP_LABEL)

    // 3. Provider route from the project's own scope only.
    const scope = `review/${sourceId}`
    const scoped: ScopedLlm = {}
    let keySha: string | undefined
    for (const name of SCOPED_LLM_NAMES) {
      const res = await get(resolveToken, `/projects/${reviewerId}/variables/${name}?filter%5Benvironment_scope%5D=${encodeURIComponent(scope)}`)
      if (res.status === 404) continue
      if (!res.ok) throw new ResolveError(`cannot read variable ${name} at scope ${scope} (${res.status}): ${MAINTAINER_HINT}`)
      const value = (await res.json() as { value?: string }).value ?? ''
      if (name === 'REVIEW_LLM_API_KEY') keySha = createHash('sha256').update(value).digest('hex').slice(0, 16)
      scoped[name] = name === 'REVIEW_LLM_API_KEY' ? 'present' : value
    }
    // A default for every project lives at scope *, which the resolve
    // environment receives too; a project scope still overrides it.
    if (scoped.REVIEW_REQUIRE_PROJECT_KEY === undefined && env.REVIEW_REQUIRE_PROJECT_KEY) scoped.REVIEW_REQUIRE_PROJECT_KEY = env.REVIEW_REQUIRE_PROJECT_KEY
    const route = decideRoute(scoped)
    if (route.route === 'invalid') {
      throw new ResolveError(`incomplete provider settings for project ${sourceId} at scope ${scope}: missing ${route.missing.join(', ')}`)
    }
    if (route.route === 'unconfigured') {
      await postUnconfiguredOnce(deps, api, botToken, sourceId, mrIid)
      deps.log(`[review] project ${sourceId} requires its own provider key and has none at scope ${scope}; not reviewing`)
      await write(noopChildYaml(`project ${sourceId} has no provider key of its own, not reviewing`, image))
      return { exitCode: 0, childPath }
    }

    await write(childPipelineYaml({
      image, sourceProjectId: sourceId, mrIid, gitlabHost: host, route: route.route, deep,
      ...(route.route === 'project' ? { baseUrl: route.baseUrl, api: route.api, model: route.model, keySha } : {}),
    }))
    deps.log(`[review] resolved project ${sourceId} !${mrIid} (upstream pipeline ${upstreamId}), route ${route.route}${deep ? ', deep requested' : ''}`)
    return { exitCode: 0, childPath }
  } catch (err) {
    deps.log(`[review] resolve failed: ${err instanceof ResolveError ? err.message : err instanceof Error ? err.message : String(err)}`)
    return { exitCode: 1, childPath }
  }
}

async function postUnconfiguredOnce(deps: ResolveDeps, api: string, botToken: string, sourceId: number, mrIid: number): Promise<void> {
  const base = api.replace(/\/api\/v4$/, '')
  const botId = await fetchBotUserId(deps.fetcher, base, botToken)
  const notesUrl = `${api}/projects/${sourceId}/merge_requests/${mrIid}/notes`
  let page = '1'
  for (let n = 0; page && n < NOTE_PAGES; n++) {
    const res = await deps.fetcher(`${notesUrl}?per_page=100&sort=desc&order_by=created_at&page=${page}`, { headers: gitlabAuthHeaders(botToken) })
    if (!res.ok) {
      // Unknown whether the note exists: posting now could duplicate it on every retry.
      deps.log(`[review] warning: could not list the MR notes (${res.status}); not posting the unconfigured note`)
      return
    }
    const notes = await res.json() as Array<{ author?: { id?: number }; body?: string }>
    if (notes.some(n => n.author?.id === botId && n.body?.includes(UNCONFIGURED_MARKER))) return
    page = res.headers.get('x-next-page') ?? ''
  }
  const body = `AI review is not configured for this project: it requires its own provider key, and none is set. Ask a maintainer of the reviewer project to add one.\n\n${UNCONFIGURED_MARKER}`
  const posted = await deps.fetcher(notesUrl, { method: 'POST', headers: { ...gitlabAuthHeaders(botToken), 'content-type': 'application/json' }, body: JSON.stringify({ body }) })
  if (!posted.ok) deps.log(`[review] warning: could not post the unconfigured note (${posted.status}); REVIEW_GITLAB_TOKEN needs Developer on the source project`)
}
