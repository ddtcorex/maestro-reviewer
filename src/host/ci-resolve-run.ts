import { join } from 'node:path'
import { gitlabAuthHeaders } from './gitlab-auth.js'
import { fetchBotUserId } from './ci-coexist.js'
import { childPipelineYaml, decideRoute, noopChildYaml, parseMrRef, SCOPED_LLM_NAMES, type ScopedLlm } from './ci-resolve.js'

/**
 * The resolve job of the reviewer pipeline (spec 3.2). Under the
 * `no_one_allowed` pipeline-variables restriction its environment is
 * trustworthy, so it asks GitLab which MR triggered it instead of believing
 * trigger variables, decides the provider route, and writes the child
 * pipeline. Reviewer-project reads use REVIEW_RESOLVE_TOKEN (Maintainer, scoped
 * to the `resolve` environment so the review job never receives it); source
 * reads use MAESTRO_GITLAB_TOKEN. Tokens are never logged or written.
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
    const botToken = need('MAESTRO_GITLAB_TOKEN')
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

    const shadowing = new Set<string>()
    let page = '1'
    for (let n = 0; page && n < 20; n++) {
      const res = await get(resolveToken, `/projects/${reviewerId}/variables?per_page=100&page=${page}`)
      if (!res.ok) throw new ResolveError(`cannot list the reviewer project's variables (${res.status}): ${MAINTAINER_HINT}`)
      for (const v of await res.json() as Array<{ key?: string }>) {
        if (v.key !== undefined && (PINNED_CHILD_NAMES as readonly string[]).includes(v.key)) shadowing.add(v.key)
      }
      page = res.headers.get('x-next-page') ?? ''
    }
    if (shadowing.size > 0) {
      throw new ResolveError(`project variable(s) ${[...shadowing].join(', ')} would override what the child pipeline pins; delete them from the reviewer project`)
    }

    // 2. Who triggered this pipeline, asked of GitLab rather than of variables.
    const query = `{ project(fullPath: ${JSON.stringify(need('CI_PROJECT_PATH'))}) { pipeline(id: ${JSON.stringify(`gid://gitlab/Ci::Pipeline/${need('CI_PIPELINE_ID')}`)}) { upstream { id project { id } } } } }`
    const gq = await deps.fetcher(`${server}/api/graphql`, { method: 'POST', headers: { ...gitlabAuthHeaders(botToken), 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
    const upstream = gq.ok ? (await gq.json() as { data?: { project?: { pipeline?: { upstream?: { id?: string; project?: { id?: string } } | null } } } }).data?.project?.pipeline?.upstream : undefined
    const upstreamId = gid(upstream?.id)
    const sourceId = gid(upstream?.project?.id)
    if (upstreamId === undefined || sourceId === undefined) {
      if (env.CI_PIPELINE_SOURCE === 'pipeline') {
        throw new ResolveError('this pipeline was triggered by another one, but its upstream is not visible: MAESTRO_GITLAB_TOKEN needs at least Reporter on the reviewer project and on the source project')
      }
      deps.log('[review] not triggered by a source pipeline, nothing to review')
      await write(noopChildYaml('not triggered by a source pipeline, nothing to review', image))
      return { exitCode: 0, childPath }
    }

    const pipeRes = await get(botToken, `/projects/${sourceId}/pipelines/${upstreamId}`)
    if (!pipeRes.ok) throw new ResolveError(`cannot read upstream pipeline ${upstreamId} of project ${sourceId} (${pipeRes.status}): MAESTRO_GITLAB_TOKEN needs at least Reporter on the source project`)
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
    for (const name of SCOPED_LLM_NAMES) {
      const res = await get(resolveToken, `/projects/${reviewerId}/variables/${name}?filter%5Benvironment_scope%5D=${encodeURIComponent(scope)}`)
      if (res.status === 404) continue
      if (!res.ok) throw new ResolveError(`cannot read variable ${name} at scope ${scope} (${res.status}): ${MAINTAINER_HINT}`)
      const value = (await res.json() as { value?: string }).value ?? ''
      scoped[name] = name === 'REVIEW_LLM_API_KEY' ? 'present' : value
    }
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
      ...(route.route === 'project' ? { baseUrl: route.baseUrl, api: route.api } : {}),
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
  const res = await deps.fetcher(`${notesUrl}?per_page=100&sort=desc&order_by=created_at`, { headers: gitlabAuthHeaders(botToken) })
  const notes = res.ok ? await res.json() as Array<{ author?: { id?: number }; body?: string }> : []
  if (notes.some(n => n.author?.id === botId && n.body?.includes(UNCONFIGURED_MARKER))) return
  const body = `AI review is not configured for this project: it requires its own provider key, and none is set. Ask a maintainer of the reviewer project to add one.\n\n${UNCONFIGURED_MARKER}`
  await deps.fetcher(notesUrl, { method: 'POST', headers: { ...gitlabAuthHeaders(botToken), 'content-type': 'application/json' }, body: JSON.stringify({ body }) })
}
