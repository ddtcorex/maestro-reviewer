import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'maestro-skills-tool'
export const inject = ['skills', 'tools']

export type ReviewSkillProfile = 'magento2' | 'laravel' | 'symfony' | 'wordpress' | 'generic'

/**
 * Exact skill names rather than a fuzzy search: a review must not silently
 * omit a security or quality pass just because a similarly named skill exists.
 */
export const REVIEW_PROFILE_SKILLS: Record<ReviewSkillProfile, readonly string[]> = {
  magento2: [
    'govard-toolbox',
    'govard-magento',
    'magento2-dev-core',
    // Frontend passes: without these a Hyvä/Tailwind MR is reviewed on model
    // priors alone (utility-class claims were unverifiable and wrong in practice).
    'magento2-frontend-dev',
    'magento2-hyva-dev',
    'magento2-code-review',
    'magento2-linter',
    'magento2-security-scan',
    'magento2-performance-audit',
  ],
  laravel: [
    'govard-toolbox',
    'govard-laravel',
    'php-dev-core',
  ],
  symfony: [
    'govard-toolbox',
    'govard-symfony',
    'php-dev-core',
  ],
  wordpress: [
    'govard-toolbox',
    'govard-wordpress',
    'php-dev-core',
  ],
  /** Diff review against general best practices; no project skill set required. */
  generic: [],
}

export const MAESTRO_SKILLS_INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/ddtcorex/maestro-skills/master/install.sh | bash -s -- --scope personal --target dsh --skills govard-toolbox,govard-magento,govard-laravel,govard-symfony,govard-wordpress,php-dev-core,magento2-dev-core,magento2-frontend-dev,magento2-hyva-dev,magento2-code-review,magento2-linter,magento2-security-scan,magento2-performance-audit -y'

// Keyed by the reviewer's Agent object itself, not a Cordis context: `ctx.agent`
// is not an actual injectable Cordis service anywhere in this composition (it
// throws "cannot get property agent without inject" whenever read, silently
// making every post-turn profile check report "not loaded" even after the
// tool above successfully set it — root-caused 2026-09-14 against a real
// failed review, reproduced deterministically against real
// @deepseek-ai/cordis). The tool's own `exec.agent` (a plain, non-Cordis
// property `ToolExecutionInput` always carries, "set by the agent loop") is
// the reliable handle — callers pass `handle.agent` from the same
// `AgentHandle` the orchestrator already holds, which is the identical object.
const loadedReviewProfiles = new WeakMap<object, ReviewSkillProfile>()

export function loadedReviewProfile(agent: object | undefined): ReviewSkillProfile | undefined {
  return agent === undefined ? undefined : loadedReviewProfiles.get(agent)
}

// Mirrors @deepseek-ai/dsh-skill's consumer-facing `SkillRegistry` (verified
// against ../../deepseek-harness/packages/skill/skill/lib/types/index.d.ts):
// `list()` returns bare `SkillSummary`-shaped entries (no `locator`/`rank` —
// those belong only to the `SkillProvider` interface a provider implements
// inside `registerProvider()`), and `get()` takes a plain name string, not a
// candidate object.
interface SkillSummaryLike {
  name: string
  description: string
}

interface SkillDefinitionLike {
  name: string
  description: string
  content: string
}

interface SkillsServiceLike {
  list(): Promise<SkillSummaryLike[]>
  get(name: string): Promise<SkillDefinitionLike | undefined>
}

/** Single owned access path to the skills service (declared via `inject`). */
export function skillsService(ctx: Context): SkillsServiceLike {
  return (ctx as unknown as { skills: SkillsServiceLike }).skills
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'maestro_load_review_profile',
    description: 'Load the complete, exact skill set required for a configured review profile. Fails if any required skill is unavailable.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Review profile configured for the project. Supported: "magento2" (full Magento skill set), "laravel" (Govard Laravel + PHP), "symfony" (Govard Symfony + PHP), "wordpress" (Govard WordPress + PHP), "generic" (no skills required).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'string', required: true },
          skills: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.skills.length === 0
          ? `Review profile "${value.profile}" loaded. No project-specific skills are required; review the diff against general correctness, security, and performance best practices.`
          : value.skills.map(s => `## ${s.name}\n\n${s.content}`).join('\n\n---\n\n'),
      }],
    },
    async execute(args, exec) {
      const required = REVIEW_PROFILE_SKILLS[args.profile as ReviewSkillProfile]
      if (required === undefined) {
        throw new Error(`Unsupported review skill profile "${args.profile}". Supported profiles: ${Object.keys(REVIEW_PROFILE_SKILLS).map(name => `"${name}"`).join(', ')}.`)
      }
      if (exec.agent === undefined) {
        throw new Error('Review profile loader is not running inside an agent context.')
      }
      const skills = skillsService(ctx)
      const available = new Set((await skills.list()).map(skill => skill.name))
      const missing = required.filter(skill => !available.has(skill))
      if (missing.length > 0) {
        throw new Error(`Missing required review skill(s) for profile "${args.profile}": ${missing.join(', ')}. Install maestro-skills for DSH with: ${MAESTRO_SKILLS_INSTALL_COMMAND}`)
      }
      const resolved = await Promise.all(required.map(skill => skills.get(skill)))
      const unavailable = required.filter((_, index) => resolved[index] === undefined)
      if (unavailable.length > 0) {
        throw new Error(`Required review skill(s) could not be loaded: ${unavailable.join(', ')}. Reinstall maestro-skills for DSH with: ${MAESTRO_SKILLS_INSTALL_COMMAND}`)
      }
      loadedReviewProfiles.set(exec.agent, args.profile as ReviewSkillProfile)
      return {
        profile: args.profile,
        skills: resolved.map(skill => ({ name: skill!.name, content: skill!.content })),
      }
    },
  }))
}
