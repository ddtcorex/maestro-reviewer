/**
 * Pure rules of the trusted CI trigger (resolve job): which MR an upstream
 * pipeline belongs to, which provider route a source project gets from its
 * environment-scoped variables, and the child pipeline that runs the review.
 * The child is emitted as JSON, which is valid YAML and needs no escaping.
 */

/** Base URLs of the OpenAI-compatible endpoints a project can pick by name. */
export const PROVIDER_PRESETS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com',
} as const

export type ReviewLlmApi = 'openai-completions' | 'openai-responses'
const APIS: readonly string[] = ['openai-completions', 'openai-responses']

/** Variables read at scope review/<id>. The key itself is only ever 'present'. */
export type ScopedLlm = Partial<Record<
  'REVIEW_LLM_API_KEY' | 'REVIEW_LLM_MODEL' | 'REVIEW_LLM_PROVIDER' | 'REVIEW_LLM_BASE_URL' | 'REVIEW_LLM_API' | 'REVIEW_REQUIRE_PROJECT_KEY',
  string
>>

// Values pinned into the child pipeline: GitLab expands `$` in job variables,
// and route.sh writes them into the settings file, so only plain characters.
const BASE_URL_RE = /^https?:\/\/[A-Za-z0-9.:/_+-]+$/
const MODEL_RE = /^[A-Za-z0-9/_+.-]+$/

export const SCOPED_LLM_NAMES = ['REVIEW_LLM_API_KEY', 'REVIEW_LLM_MODEL', 'REVIEW_LLM_PROVIDER', 'REVIEW_LLM_BASE_URL', 'REVIEW_LLM_API', 'REVIEW_REQUIRE_PROJECT_KEY'] as const

export type Route =
  | { route: 'project'; baseUrl: string; api: ReviewLlmApi; model: string }
  | { route: 'default' }
  | { route: 'unconfigured' }
  | { route: 'invalid'; missing: string[] }

/** Allowlist entries from REVIEW_ALLOWED_NAMESPACES (comma separated). */
export function parseAllowedNamespaces(value: string | undefined): string[] {
  return (value ?? '').split(',').map(e => e.trim().replace(/\/+$/, '')).filter(Boolean)
}

/** A project path is allowed when an entry is the project itself or one of its parent namespaces. */
export function namespaceAllowed(projectPath: string, entries: readonly string[]): boolean {
  return entries.some(e => projectPath === e || projectPath.startsWith(`${e}/`))
}

/**
 * The file in another project that GitLab loads for a CI config path
 * (`<file>@<namespace>/<project>[:<ref>]`), else undefined. Mirrors GitLab's
 * own resolution (lib/gitlab/ci/project_config, 17.11 to 18.11): any value
 * with an http(s) scheme is a remote file, the external-project rule is the
 * case-sensitive `.+(yml|yaml)@.+`, and the value splits on the first `@`
 * and then the first `:`; nothing is trimmed. Anything else GitLab reads
 * from the reviewer repository itself, so it is refused.
 */
export function parseCiConfigPath(value: string | null | undefined): { file: string; project: string; ref?: string } | undefined {
  const v = value ?? ''
  if (v === '' || v !== v.trim() || /https?:/i.test(v) || !/^.+(yml|yaml)@.+$/.test(v)) return undefined
  const at = v.indexOf('@')
  const file = v.slice(0, at)
  const rest = v.slice(at + 1)
  const colon = rest.indexOf(':')
  const project = colon === -1 ? rest : rest.slice(0, colon)
  const ref = colon === -1 ? undefined : rest.slice(colon + 1)
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(project)) return undefined
  if (ref !== undefined && !/^\S+$/.test(ref)) return undefined
  return ref === undefined ? { file, project } : { file, project, ref }
}

/** Whether a protected-branch rule name (exact, or with `*` wildcards) covers a branch, as GitLab matches it. */
export function protectionMatches(rule: string, branch: string): boolean {
  if (!rule.includes('*')) return rule === branch
  const re = new RegExp(`^${rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(branch)
}

/** MR iid of a merge request pipeline ref (head, merge or train), else undefined. */
export function parseMrRef(ref: string): number | undefined {
  const m = /^refs\/merge-requests\/(\d+)\/(?:head|merge|train)$/.exec(ref)
  return m ? Number(m[1]) : undefined
}

/**
 * A project route is all or nothing (spec 3.3): GitLab merges variables one
 * by one, so a partial scope would inherit the default endpoint and send the
 * project's key there. Anything partial fails closed with the missing names.
 */
export function decideRoute(scoped: ScopedLlm): Route {
  const hasKey = scoped.REVIEW_LLM_API_KEY !== undefined
  if (!hasKey) {
    const stray = (['REVIEW_LLM_MODEL', 'REVIEW_LLM_PROVIDER', 'REVIEW_LLM_BASE_URL', 'REVIEW_LLM_API'] as const).some(n => scoped[n] !== undefined)
    if (stray) return { route: 'invalid', missing: ['REVIEW_LLM_API_KEY'] }
    return scoped.REVIEW_REQUIRE_PROJECT_KEY === '1' ? { route: 'unconfigured' } : { route: 'default' }
  }
  const provider = scoped.REVIEW_LLM_PROVIDER
  const missing: string[] = []
  if (scoped.REVIEW_LLM_MODEL === undefined) missing.push('REVIEW_LLM_MODEL')
  if (provider === undefined && scoped.REVIEW_LLM_BASE_URL === undefined) missing.push('REVIEW_LLM_PROVIDER or REVIEW_LLM_BASE_URL')
  if (provider === 'custom' && scoped.REVIEW_LLM_BASE_URL === undefined) missing.push('REVIEW_LLM_BASE_URL')
  if (provider !== undefined && provider !== 'custom' && !(provider in PROVIDER_PRESETS)) missing.push(`REVIEW_LLM_PROVIDER (unknown: ${provider})`)
  if (scoped.REVIEW_LLM_API !== undefined && !APIS.includes(scoped.REVIEW_LLM_API)) missing.push(`REVIEW_LLM_API (unknown: ${scoped.REVIEW_LLM_API})`)
  if (scoped.REVIEW_LLM_BASE_URL !== undefined && !BASE_URL_RE.test(scoped.REVIEW_LLM_BASE_URL)) missing.push('REVIEW_LLM_BASE_URL (unsafe value)')
  if (scoped.REVIEW_LLM_MODEL !== undefined && !MODEL_RE.test(scoped.REVIEW_LLM_MODEL)) missing.push('REVIEW_LLM_MODEL (unsafe value)')
  if (missing.length > 0) return { route: 'invalid', missing }
  const baseUrl = scoped.REVIEW_LLM_BASE_URL ?? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
  return { route: 'project', baseUrl, api: (scoped.REVIEW_LLM_API ?? 'openai-completions') as ReviewLlmApi, model: scoped.REVIEW_LLM_MODEL as string }
}

export interface ChildOptions {
  image: string
  sourceProjectId: number
  mrIid: number
  gitlabHost: string
  route: 'project' | 'default' | 'unconfigured'
  baseUrl?: string
  api?: string
  /** Project route: the model, and a sha256 prefix of the key resolve saw (route.sh refuses any other key). */
  model?: string
  keySha?: string
  deep: boolean
}

/** The child pipeline: identity and route as literals, never `$` references. */
export function childPipelineYaml(o: ChildOptions): string {
  const variables: Record<string, string> = {
    SOURCE_PROJECT_ID: String(o.sourceProjectId),
    MR_IID: String(o.mrIid),
    GITLAB_HOST: o.gitlabHost,
    REVIEW_ROUTE: o.route,
  }
  if (o.route === 'project') {
    variables.REVIEW_ROUTE_BASE_URL = o.baseUrl ?? ''
    variables.REVIEW_ROUTE_API = o.api ?? 'openai-completions'
    variables.REVIEW_ROUTE_MODEL = o.model ?? ''
    variables.REVIEW_ROUTE_KEY_SHA = o.keySha ?? ''
  }
  if (o.deep) {
    variables.REVIEW_MODE = 'deep'
    variables.REVIEW_DEEP_REQUESTED = '1'
  }
  const key = `${o.sourceProjectId}-${o.mrIid}`
  const review = {
    image: o.image,
    environment: { name: `review/${o.sourceProjectId}`, action: 'prepare' },
    variables: { GIT_STRATEGY: 'none', ...variables },
    script: ['/entrypoint.sh'],
    resource_group: `review-${key}`,
    cache: { key: `maestro-review-${key}`, paths: ['.maestro-history/'] },
    artifacts: { when: 'always', expire_in: '1 week', paths: ['review-report.json', 'review-report.md', 'gl-code-quality-report.json'], reports: { codequality: 'gl-code-quality-report.json' } },
  }
  return `${JSON.stringify({ review }, null, 2)}\n`
}

/** A valid child that only explains why nothing was reviewed. */
export function noopChildYaml(reason: string, image: string): string {
  return `${JSON.stringify({ skip: { image: { name: image, entrypoint: [''] }, variables: { GIT_STRATEGY: 'none' }, script: [`echo ${JSON.stringify(`[review] ${reason}`)}`] } }, null, 2)}\n`
}
