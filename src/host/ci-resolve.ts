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

export const SCOPED_LLM_NAMES = ['REVIEW_LLM_API_KEY', 'REVIEW_LLM_MODEL', 'REVIEW_LLM_PROVIDER', 'REVIEW_LLM_BASE_URL', 'REVIEW_LLM_API', 'REVIEW_REQUIRE_PROJECT_KEY'] as const

export type Route =
  | { route: 'project'; baseUrl: string; api: ReviewLlmApi }
  | { route: 'default' }
  | { route: 'unconfigured' }
  | { route: 'invalid'; missing: string[] }

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
  if (missing.length > 0) return { route: 'invalid', missing }
  const baseUrl = scoped.REVIEW_LLM_BASE_URL ?? PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS]
  return { route: 'project', baseUrl, api: (scoped.REVIEW_LLM_API ?? 'openai-completions') as ReviewLlmApi }
}

export interface ChildOptions {
  image: string
  sourceProjectId: number
  mrIid: number
  gitlabHost: string
  route: 'project' | 'default' | 'unconfigured'
  baseUrl?: string
  api?: string
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
    artifacts: { when: 'always', expire_in: '1 week', paths: ['review-report.json', 'review-report.md'] },
  }
  return `${JSON.stringify({ review }, null, 2)}\n`
}

/** A valid child that only explains why nothing was reviewed. */
export function noopChildYaml(reason: string, image: string): string {
  return `${JSON.stringify({ skip: { image: { name: image, entrypoint: [''] }, variables: { GIT_STRATEGY: 'none' }, script: [`echo ${JSON.stringify(`[review] ${reason}`)}`] } }, null, 2)}\n`
}
