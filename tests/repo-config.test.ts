import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPO_CONFIG_PATH, configChangedInMr, effectiveConfig, parseRepoConfig } from '../src/host/repo-config.js'
import { DEFAULT_IGNORE_GLOBS } from '../src/host/diff-filter.js'
import { DEFAULT_FANOUT } from '../src/host/chunking.js'
import { reviewerPromptParts } from '../src/host/orchestrator.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})
afterEach(() => vi.unstubAllGlobals())

describe('parseRepoConfig', () => {
  it('reads every supported field', () => {
    const { config, warnings } = parseRepoConfig([
      'profile: magento2', 'ignore: ["node/**"]', 'rules:', '  - Never log customer emails.', 'minSeverity: minor', 'language: fr-FR', 'fanout: { files: 40, bytes: 200000 }',
    ].join('\n'))
    expect(warnings).toEqual([])
    expect(config).toEqual({ profile: 'magento2', ignore: ['node/**'], rules: ['Never log customer emails.'], minSeverity: 'minor', language: 'fr-FR', fanout: { files: 40, bytes: 200000 } })
  })

  it('falls back to the defaults with one warning on invalid YAML or an invalid field', () => {
    for (const text of ['profile: [unclosed', 'profile: rails', 'rules: "one string"', `rules: [${JSON.stringify('x'.repeat(501))}]`, `rules: [${Array(31).fill('"r"').join(',')}]`, 'language: "not a tag!"', 'fanout: { files: 0 }']) {
      const { config, warnings } = parseRepoConfig(text)
      expect(config, text).toEqual({})
      expect(warnings, text).toHaveLength(1)
    }
  })

  it('refuses a gate key: the merge gate is operator only', () => {
    const { config, warnings } = parseRepoConfig('gate: off\nprofile: generic')
    expect(config).toEqual({})
    expect(warnings[0]).toMatch(/gate/)
  })

  it('treats an empty file as no settings', () => {
    expect(parseRepoConfig('')).toEqual({ config: {}, warnings: [] })
  })
})

describe('effectiveConfig', () => {
  it('applies env over the file over the defaults', () => {
    const file = { profile: 'laravel' as const, ignore: ['node/**'], fanout: { files: 40, bytes: 200000 }, minSeverity: 'major' as const, rules: ['r1'], language: 'fr' }
    const eff = effectiveConfig({ profile: 'magento2', ignoreGlobs: ['docs/**'], fanout: { files: 10 } }, file)
    expect(eff).toEqual({
      profile: 'magento2', ignoreGlobs: [...DEFAULT_IGNORE_GLOBS, 'node/**', 'docs/**'],
      fanout: { ...DEFAULT_FANOUT, files: 10, bytes: 200000 }, minSeverity: 'major', rules: ['r1'], language: 'fr',
    })
    expect(effectiveConfig({ ignoreGlobs: [], fanout: {} }, file).profile).toBe('laravel')
  })
})

describe('configChangedInMr', () => {
  it('is true only when the MR touches the config file', () => {
    expect(configChangedInMr(['a.php', REPO_CONFIG_PATH])).toBe(true)
    expect(configChangedInMr(['a.php', 'sub/.maestro-review.yml'])).toBe(false)
  })
})

describe('reading the file', () => {
  it('reads from the target branch and answers undefined for a missing file', async () => {
    const { fetchRepoFile } = await import('../src/host/forge/gitlab/mr-api.js')
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => { urls.push(url); return url.includes('missing') ? new Response('nope', { status: 404 }) : new Response('profile: generic', { status: 200 }) })
    expect(await fetchRepoFile(fetcher as any, { baseUrl: 'https://g', token: 't', projectId: 5, ref: 'main', path: REPO_CONFIG_PATH })).toBe('profile: generic')
    expect(urls[0]).toBe('https://g/api/v4/projects/5/repository/files/.maestro-review.yml/raw?ref=main')
    expect(await fetchRepoFile(fetcher as any, { baseUrl: 'https://g', token: 't', projectId: 5, ref: 'missing', path: REPO_CONFIG_PATH })).toBeUndefined()
    await expect(fetchRepoFile(vi.fn(async () => new Response('x', { status: 500 })) as any, { baseUrl: 'https://g', token: 't', projectId: 5, ref: 'main', path: REPO_CONFIG_PATH })).rejects.toThrow(/500/)
  })
})

describe('prompt', () => {
  it('carries the project rules and the comment language in the per-MR part', () => {
    const parts = reviewerPromptParts({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: null, repoRules: ['Never log customer emails.'], language: 'fr-FR' })
    const dynamic = parts.dynamic.join('\n')
    expect(dynamic).toContain('Never log customer emails.')
    expect(dynamic).toContain('fr-FR')
    expect(parts.stable.join('')).not.toContain('Never log')
  })
})

function engineForge(paths: string[], posted: any[], notes: string[]) {
  return {
    mrHeadSha: async () => 'c0ffee', mrBaseSha: async () => 'b1', compare: async () => undefined,
    reviewScope: async () => ({ files: paths.map((path) => ({ path, bytes: 10 })), skipped: [] }), restrictToInterdiff: () => {},
    postNote: async (b: string) => { notes.push(b) }, replyToDiscussion: async () => {}, postFindings: async (fs: any[]) => { posted.push(...fs) },
    signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
  }
}

async function runEngine(paths: string[], repo: Record<string, unknown>, reviewer: (...a: any[]) => Promise<any>) {
  const { createReviewEngine } = await import('../src/host/engine.js')
  const posted: any[] = []
  const notes: string[] = []
  await createReviewEngine({} as any, { reviewer: vi.fn(reviewer), auditor: vi.fn() } as any).run(
    { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'c0ffee', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
    { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: engineForge(paths, posted, notes) as any, repo },
  )
  return { posted, notes }
}

describe('engine with repository settings', () => {
  it('posts a CFG-CHANGED finding and a notice when the MR changes the config file', async () => {
    const { posted, notes } = await runEngine(['a.php', REPO_CONFIG_PATH], {}, async () => ({ summary: '0 new inline comment(s), 0 thread(s) updated.', failures: [] }))
    expect(posted.map((f) => f.code)).toEqual(['CFG-CHANGED'])
    expect(posted[0]).toMatchObject({ status: 'new', path: REPO_CONFIG_PATH, line: 1 })
    expect(notes[0]).toContain('applies after merge')
  })

  it('hands minSeverity and the warnings to the run, and names the warnings in the comment', async () => {
    let seen: any
    const { notes } = await runEngine(['a.php'], { minSeverity: 'major', warnings: ['.maestro-review.yml: unknown key "gate"'] }, async (_w, _p, run) => { seen = run; return { summary: 'ok', failures: [] } })
    expect(seen.minSeverity).toBe('major')
    expect(notes[0]).toContain('unknown key "gate"')
  })
})

describe('posting with a minimum severity', () => {
  it('posts only findings at or above it and keeps every finding counted', async () => {
    const { postFindingsSequentially } = await import('../src/host/engine.js')
    const posted: any[] = []
    const forge = { postFindings: async (fs: any[]) => { posted.push(...fs) } }
    const findings = [{ status: 'new', path: 'a', line: 1, body: 'x', severity: 'nit' }, { status: 'new', path: 'a', line: 2, body: 'y', severity: 'major' }, { status: 'reply', discussionId: 'd', body: 'z', severity: 'minor' }] as any[]
    const r = await postFindingsSequentially(forge as any, findings, { minSeverity: 'major' })
    expect(posted.map((f) => f.line ?? f.discussionId)).toEqual([2])
    expect(r).toMatchObject({ postedNew: 1, postedReplies: 0, belowMinimum: 2 })
  })
})

describe('ci trigger with a repository config file', () => {
  const run = async (fileBody: string | undefined, env: Record<string, string> = {}) => {
    const { parseCiEnvConfig, runCiTrigger } = await import('../src/host/providers/ci-trigger.js')
    const cfg = parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2', ...env })
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/repository/files/')) return fileBody === undefined ? new Response('', { status: 404 }) : new Response(fileBody, { status: 200 })
      if (url.endsWith('/user')) return new Response(JSON.stringify({ id: 7 }), { status: 200 })
      if (/notes|award_emoji|discussions/.test(url)) return new Response('[]', { status: 200 })
      if (url.endsWith('/projects/1')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      return new Response(JSON.stringify({ source_branch: 'feat/x', target_branch: 'develop', sha: 'abc' }), { status: 200 })
    })
    const engine = vi.fn(async () => ({ ok: true, summary: 'x', failures: [], durationMs: 1 }))
    await runCiTrigger({ reviewEngine: { run: engine } } as any, cfg, { fetcher: fetcher as any, writeFile: (async () => {}) as any })
    return { opts: (engine.mock.calls[0] as any[])[1], req: (engine.mock.calls[0] as any[])[0], urls }
  }

  it('reads the file from the default branch and applies it under the environment', async () => {
    const { opts, req, urls } = await run('profile: magento2\nignore: ["node/**"]\nminSeverity: major\nfanout: { files: 40 }', { REVIEW_IGNORE_GLOBS: 'docs/**' })
    expect(urls.some((u) => u.endsWith('/repository/files/.maestro-review.yml/raw?ref=main'))).toBe(true)
    expect(opts.access).toEqual({ kind: 'clone', host: 'h' })
    expect(req.reviewProfile).toBe('magento2')
    expect(opts.ignoreGlobs.slice(-2)).toEqual(['node/**', 'docs/**'])
    expect(opts.fanout.files).toBe(40)
    expect(opts.repo).toMatchObject({ minSeverity: 'major', warnings: [] })
  })

  it('lets REVIEW_PROFILE win and keeps the defaults when there is no file', async () => {
    expect((await run('profile: magento2', { REVIEW_PROFILE: 'generic' })).opts.access).toEqual({ kind: 'diff' })
    const none = await run(undefined)
    expect(none.opts.access).toEqual({ kind: 'diff' })
    expect(none.opts.repo).toMatchObject({ warnings: [] })
  })

  it('passes a warning, never fails, on an invalid file', async () => {
    expect((await run('gate: off')).opts.repo.warnings[0]).toMatch(/gate/)
  })
})
