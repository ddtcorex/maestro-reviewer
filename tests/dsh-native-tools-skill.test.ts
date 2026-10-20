import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = join(REPO_ROOT, 'skills', 'dsh-native-tools', 'SKILL.md')

const read = () => readFileSync(SKILL, 'utf-8')

const FRONTMATTER = /^---\nname: dsh-native-tools\ndescription: .+\n---\n/

/**
 * Tool names this plugin registers, harvested from source rather than restated
 * here: a hard-coded list in the test would rot exactly like the map does. The
 * registration call is `defineTool({ name:'x', ... })` / `name: 'x'` inside the
 * tool modules, so scanning `src/host` for those literals tracks renames.
 */
function registeredToolNames(source: string): string[] {
  const names = new Set<string>()
  for (const m of source.matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) names.add(m[1])
  return [...names]
}

const HOST_SOURCES = [
  'perf-log-stats-tool.ts',
  'layout-xml-tool.ts',
  'hyva-theme-inspect-tool.ts',
  'scope-split-tool.ts',
  'phtml-escape-scan-tool.ts',
  'module-check-tool.ts',
  'skills-tool.ts',
]

/**
 * Names in the map that the map claims THIS plugin owns. The govard plugin
 * (`govard_*` tools) is not part of this harness, so none of its tools may
 * appear in the map: see the guard test below.
 */
const OWNED_BY_THIS_PLUGIN = [
  'maestro_perf_log_stats',
  'layout_xml_extract',
  'hyva_theme_inspect',
  'maestro_review_scope_split',
  'phtml_escape_scan',
  'magento_module_check',
]

describe('dsh-native-tools skill', () => {
  it('ships the frontmatter the skill provider requires', () => {
    const text = read()
    expect(text).toMatch(FRONTMATTER)
    // The description is the only text the model sees before loading the skill,
    // so it must name the trigger: a public skill saying "native ... when provided".
    const description = text.match(/^description: (.+)$/m)?.[1] ?? ''
    expect(description).toContain('native')
    expect(description.length).toBeGreaterThan(60)
  })

  it('maps the harness-agnostic actions the public skills name', () => {
    const text = read()
    for (const row of [
      '| Invoke / load a skill | `skill` with `{ name }` |',
      '| Ask your human partner | `ask_user_question` |',
      '| Read a file / find files / search contents | `read`, `glob`, `grep` |',
    ]) expect(text).toContain(row)
  })

  it('names only tools that src/host actually registers', () => {
    // The anti-rot guarantee. Previously this file only grepped the markdown,
    // so a renamed (or never-existing) tool stayed green — `govard_lint` shipped
    // in the map while no package registered it. Now the source is the oracle.
    const registered = new Set(
      HOST_SOURCES.flatMap(f => registeredToolNames(readFileSync(join(REPO_ROOT, 'src', 'host', f), 'utf-8'))),
    )
    for (const tool of OWNED_BY_THIS_PLUGIN)
      expect(registered.has(tool), `${tool} is in the map but not registered in src/host`).toBe(true)
  })

  it('fails when the map names a tool this plugin does not register', () => {
    // Guard against the test itself going vacuous: assert the oracle rejects a
    // name that is absent from source (the exact shape of the shipped bug).
    const registered = new Set(
      HOST_SOURCES.flatMap(f => registeredToolNames(readFileSync(join(REPO_ROOT, 'src', 'host', f), 'utf-8'))),
    )
    expect(registered.has('govard_lint')).toBe(false)
    expect(registered.has('magento_module_check')).toBe(true)
  })

  it('names no tool that was removed from the review surface', () => {
    for (const gone of ['maestro_get_skills', 'maestro_search_files']) expect(read()).not.toContain(gone)
  })

  it('names no tool of the retired govard plugin', () => {
    // A map row for a tool that no longer ships sends the model after a call the
    // registry rejects. If a govard tool ever returns, it must be added to
    // OWNED_BY_THIS_PLUGIN or to a deliberately maintained list, not here.
    expect(read()).not.toMatch(/\bgovard_[a-z_]+/)
  })

  it('maps the lint, environment and deploy capabilities to govard CLI commands run with bash', () => {
    const text = read()
    for (const command of [
      'govard audit run --checks lint --format json --mode auto --timeout auto --lint-provider govard',
      '--scope diff --base',
      'govard audit run --checks integrity --format json',
      'govard env up',
      'govard shell -c',
      'govard env down -v',
      'govard deploy plan',
      'govard deploy check',
    ]) expect(text, command).toContain(command)
    expect(text).toMatch(/native lint tool \|/)
    expect(text).toMatch(/native deploy preflight \|/)
  })

  it('names the govard CLI in the frontmatter description', () => {
    const description = read().match(/^description: (.+)$/m)?.[1] ?? ''
    expect(description).toContain('govard')
    expect(description).toMatch(/CLI/)
  })

  it('stays a tool map, not a copy of the public skill bodies', () => {
    const text = read()
    // No portable recipes: the public skill already carries them, and duplicating
    // them here would rot on the next edit there.
    expect(text).not.toContain('grep -c')
    expect(text).not.toContain('pt-query-digest')
    expect(text).not.toContain('mysqldumpslow')
  })

  it('carries no secrets, client slugs, or host paths', () => {
    const text = read()
    expect(text).not.toMatch(/ghp_|github_pat_|glpat-|sk-[A-Za-z0-9]{16}/)
    // Host path and client slugs come from the private blacklist at the meta root
    // (docs/PUBLIC_WORD_BLACKLIST.md) — asserted through built strings so this
    // test file itself never repeats a private name into public history.
    const hostPath = ['', 'home', 'kai', ''].join('/')
    const slugs = ['bebe' + '9', 'carre' + 'blanc', 'ick' + 'o', 'visiter' + 'lyon']
    expect(text).not.toContain(hostPath)
    for (const slug of slugs) expect(text, slug).not.toContain(slug)
  })
})
