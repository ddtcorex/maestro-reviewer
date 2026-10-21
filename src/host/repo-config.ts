import { parse } from 'yaml'
import { DEFAULT_FANOUT, type FanoutSettings } from './chunking.js'
import { resolveIgnoreGlobs } from './diff-filter.js'
import type { FindingSeverity } from './review-findings-tool.js'
import type { ReviewSkillProfile } from './skills-tool.js'

/**
 * Per-project review settings from `.maestro-review.yml` (spec section 7,
 * F1). The file is read from the MR target branch, the merged and already
 * reviewed state, never from the head: an author must not widen the ignore
 * globs or raise the minimum severity to hide their own change. The merge
 * gate is not a file field. Any invalid content means no settings plus one
 * warning, never a failed review.
 */

export const REPO_CONFIG_PATH = '.maestro-review.yml'

export interface RepoReviewConfig {
  profile?: ReviewSkillProfile
  ignore?: string[]
  rules?: string[]
  minSeverity?: FindingSeverity
  language?: string
  fanout?: { files?: number; bytes?: number }
}

const PROFILES: readonly string[] = ['magento2', 'laravel', 'symfony', 'wordpress', 'generic']
const SEVERITIES: readonly string[] = ['blocking', 'major', 'minor', 'nit']
const KEYS = ['profile', 'ignore', 'rules', 'minSeverity', 'language', 'fanout']
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const MAX_RULES = 30
const MAX_RULE_CHARS = 500

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const positive = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0

/** Pure. Returns the settings, or none plus one warning naming every problem. */
export function parseRepoConfig(text: string): { config: RepoReviewConfig; warnings: string[] } {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (err) {
    return { config: {}, warnings: [`${REPO_CONFIG_PATH} is not valid YAML (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); using the defaults`] }
  }
  if (raw === null || raw === undefined) return { config: {}, warnings: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { config: {}, warnings: [`${REPO_CONFIG_PATH} must be a mapping; using the defaults`] }
  const o = raw as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(o)) {
    if (key === 'gate') problems.push('"gate" is not a file setting (the merge gate is set on the reviewer project)')
    else if (!KEYS.includes(key)) problems.push(`unknown key "${key}"`)
  }
  if (o.profile !== undefined && !PROFILES.includes(o.profile as string)) problems.push(`profile must be one of ${PROFILES.join(', ')}`)
  if (o.ignore !== undefined && !isStrings(o.ignore)) problems.push('ignore must be a list of globs')
  if (o.rules !== undefined && (!isStrings(o.rules) || o.rules.length > MAX_RULES || o.rules.some((r) => r.length > MAX_RULE_CHARS))) problems.push(`rules must be a list of at most ${MAX_RULES} texts of at most ${MAX_RULE_CHARS} characters`)
  if (o.minSeverity !== undefined && !SEVERITIES.includes(o.minSeverity as string)) problems.push(`minSeverity must be one of ${SEVERITIES.join(', ')}`)
  if (o.language !== undefined && (typeof o.language !== 'string' || !BCP47.test(o.language))) problems.push('language must be a language tag such as en or fr-FR')
  if (o.fanout !== undefined) {
    const f = o.fanout as Record<string, unknown> | null
    if (f === null || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some((k) => k !== 'files' && k !== 'bytes') || (f.files !== undefined && !positive(f.files)) || (f.bytes !== undefined && !positive(f.bytes))) {
      problems.push('fanout takes positive integers files and bytes')
    }
  }
  if (problems.length > 0) return { config: {}, warnings: [`${REPO_CONFIG_PATH}: ${problems.join('; ')}; using the defaults`] }
  return { config: o as RepoReviewConfig, warnings: [] }
}

export function configChangedInMr(paths: string[]): boolean {
  return paths.includes(REPO_CONFIG_PATH)
}

export interface EnvReviewOverrides {
  profile?: ReviewSkillProfile
  /** REVIEW_IGNORE_GLOBS entries, without the defaults. */
  ignoreGlobs: string[]
  /** Fan-out values set in the environment. */
  fanout: Partial<FanoutSettings>
}

export interface EffectiveReviewConfig {
  profile?: ReviewSkillProfile
  ignoreGlobs: string[]
  fanout: FanoutSettings
  minSeverity?: FindingSeverity
  rules: string[]
  language?: string
}

/** Pure. Environment over file over defaults; ignore globs add up (defaults, file, environment). */
export function effectiveConfig(env: EnvReviewOverrides, file: RepoReviewConfig): EffectiveReviewConfig {
  const profile = env.profile ?? file.profile
  return {
    ...(profile !== undefined ? { profile } : {}),
    ignoreGlobs: resolveIgnoreGlobs({ REVIEW_IGNORE_GLOBS: env.ignoreGlobs.join(',') }, file.ignore ?? []),
    fanout: { ...DEFAULT_FANOUT, ...file.fanout, ...env.fanout },
    ...(file.minSeverity !== undefined ? { minSeverity: file.minSeverity } : {}),
    rules: file.rules ?? [],
    ...(file.language !== undefined ? { language: file.language } : {}),
  }
}
