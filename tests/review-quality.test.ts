import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deniedToolForReview } from '../src/host/tool-policy.js'
import { buildReviewComment, reviewerPromptParts } from '../src/host/orchestrator.js'
import { effectiveConfig } from '../src/host/repo-config.js'
import { DEFAULT_FANOUT } from '../src/host/chunking.js'
import { whitelistFindings } from '../src/host/composer-context.js'
import { selectOwnThreads } from '../src/host/forge/gitlab/gitlab-client.js'
import { redactWorktree } from '../src/host/redact-worktree.js'

describe('web tools', () => {
  it('are denied to review agents', () => {
    expect(deniedToolForReview('web_fetch')).toMatch(/not available/)
    expect(deniedToolForReview('web_search')).toMatch(/not available/)
  })

  it('the prompt tells the reviewer not to fetch framework sources', () => {
    const { stable } = reviewerPromptParts({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: null })
    expect(stable.join('')).toMatch(/no web access/i)
  })
})

describe('working-pattern rule', () => {
  it('makes a "this cannot work" finding check code that already uses the same pattern', () => {
    for (const scopeKind of ['full', 'discussion'] as const) {
      const { stable } = reviewerPromptParts({ scopeKind, mode: 'quick', profileInstruction: '', lint: null, discussionId: 'd', path: 'a', line: 1 } as any)
      const text = stable.join('')
      expect(text).toMatch(/WORKING PATTERN RULE/)
      expect(text).toMatch(/same pattern/)
      expect(text).toMatch(/downgrade|drop/)
    }
  })
})

describe('false-positive guards', () => {
  const text = (scopeKind: 'full' | 'discussion') =>
    reviewerPromptParts({ scopeKind, mode: 'quick', profileInstruction: '', lint: null, discussionId: 'd', path: 'a', line: 1 } as any).stable.join('')

  it('caps a claim about framework or vendor behaviour the checkout cannot show', () => {
    for (const k of ['full', 'discussion'] as const) {
      expect(text(k)).toMatch(/UNVERIFIED RULE/)
      expect(text(k)).toMatch(/at most minor/)
      expect(text(k)).toMatch(/question/)
    }
  })

  it('treats behaviour the code or docs call intended as a design question, not a bug', () => {
    for (const k of ['full', 'discussion'] as const) {
      expect(text(k)).toMatch(/DOCUMENTED INTENT RULE/)
      expect(text(k)).toMatch(/docblock/)
    }
  })

  it('keeps a thread the author answered settled unless new evidence appears', () => {
    const t = text('full')
    expect(t).toMatch(/SETTLED THREAD RULE/)
    expect(t).toMatch(/humanReplies/)
    expect(t).toMatch(/never raise its severity/)
    expect(t).toMatch(/never open a new thread/)
  })
})

describe('fan-out', () => {
  it('is off unless the environment or the repo file sets it', async () => {
    expect(effectiveConfig({ ignoreGlobs: [], fanout: {} }, {}).fanout).toBeUndefined()
    expect(effectiveConfig({ ignoreGlobs: [], fanout: { files: 10 } }, {}).fanout).toEqual({ ...DEFAULT_FANOUT, files: 10 })
    expect(effectiveConfig({ ignoreGlobs: [], fanout: {} }, { fanout: { bytes: 9 } }).fanout).toEqual({ ...DEFAULT_FANOUT, bytes: 9 })
    const { parseCiEnvConfig, ciFanout } = await import('../src/host/providers/ci-trigger.js')
    expect(ciFanout(parseCiEnvConfig({ GITLAB_HOST: 'h', REVIEW_GITLAB_TOKEN: 't', SOURCE_PROJECT_ID: '1', MR_IID: '2' }))).toEqual({})
  })
})

describe('partial review comment', () => {
  const base = { projectPath: 'g/p', mrIid: 1, gitlabBaseUrl: 'https://g', mode: 'deep', summary: 's', failures: [] }
  it('shows a warning instead of the completed mark, with the unreviewed file count', () => {
    const body = buildReviewComment({ ...base, partial: { unreviewed: 50 } })
    expect(body).toContain('⚠️ Partial')
    expect(body).not.toContain('✅ Completed')
    expect(body).toMatch(/50 file\(s\) were not reviewed/)
  })

  it('keeps the completed mark for a whole review', () => {
    expect(buildReviewComment(base)).toContain('✅ Completed')
  })
})

describe('MAGENTO-DB-WHITELIST', () => {
  it('is minor and says the whitelist matters for removals and renames', () => {
    const [f] = whitelistFindings([{ module: 'app/code/A/B' }])
    expect(f.severity).toBe('minor')
    expect(f.body).toMatch(/drop|rename/)
  })
})

describe('own threads listed to the model', () => {
  const note = (body: string) => ({ id: 'd', notes: [{ body, author: { username: 'bot' }, position: { new_path: 'a', new_line: 1 }, resolved: false }] })
  it('leave out the threads the engine made', () => {
    const r = selectOwnThreads([
      { ...note('x <!-- maestro-finding code=MAGENTO-DB-WHITELIST -->'), id: 'w' },
      { ...note('x <!-- maestro-finding code=SEC-SECRET-IN-DIFF -->'), id: 's' },
      { ...note('x <!-- maestro-finding code=CFG-CHANGED -->'), id: 'c' },
      { ...note('x <!-- maestro-finding code=PHP-XSS -->'), id: 'm' },
    ] as any, 'bot')
    expect(r.threads.map((t) => t.discussionId)).toEqual(['m'])
  })
})

describe('checkout redaction', () => {
  it('masks secrets only, never emails or phone numbers', async () => {
    const root = await mkdtemp('/tmp/maestro-quality-')
    try {
      await writeFile(join(root, 'a.php'), "contact: shop@example.com +33 1 23 45 67 89\n'password' => 'hunter2'\n")
      const r = await redactWorktree(root)
      const text = await readFile(join(root, 'a.php'), 'utf8')
      expect(text).toContain('shop@example.com')
      expect(text).toContain('+33 1 23 45 67 89')
      expect(text).toContain('[REDACTED:env-secret]')
      expect(r).toEqual({ files: 1, hits: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deterministic dedupe (C1)', () => {
  it('a blocking finding is not hidden by an open major thread of the same code and path', async () => {
    const { openFindingKeys, hasOpenThread } = await import('../src/host/review-feedback.js')
    const majorOpen = new Set(openFindingKeys('SEC-SECRET-IN-DIFF', '.env', '🟡 Major: x'))
    expect(hasOpenThread({ code: 'SEC-SECRET-IN-DIFF', path: '.env', severity: 'blocking' }, majorOpen)).toBe(false)
    expect(hasOpenThread({ code: 'SEC-SECRET-IN-DIFF', path: '.env', severity: 'major' }, majorOpen)).toBe(true)
    const blockingOpen = new Set(openFindingKeys('SEC-SECRET-IN-DIFF', '.env', '🔴 Blocking: x'))
    expect(hasOpenThread({ code: 'SEC-SECRET-IN-DIFF', path: '.env', severity: 'blocking' }, blockingOpen)).toBe(true)
  })
})

describe('host worktree redaction (I3)', () => {
  it('runs exactly when no runtime audit runs', async () => {
    const { redactsWorkspace } = await import('../src/host/redact-worktree.js')
    const mr = { kind: 'mr' as const }
    const disc = { kind: 'discussion' as const }
    expect(redactsWorkspace({ mode: 'deep', scope: mr }, 'runtime')).toBe(false)
    expect(redactsWorkspace({ mode: 'deep', scope: disc }, 'runtime')).toBe(true)
    expect(redactsWorkspace({ mode: 'quick', scope: mr }, 'runtime')).toBe(true)
    expect(redactsWorkspace({ mode: 'deep', scope: mr }, 'static')).toBe(true)
  })

  it('removes a symlink into .git, which the walk never redacts', async () => {
    const { symlink, lstat, mkdir } = await import('node:fs/promises')
    const root = await mkdtemp('/tmp/maestro-quality-')
    try {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, '.git', 'config'), 'url = https://oauth2:glpat-abcdefghijklmnopqrstu@h/x.git\n')
      await symlink(join(root, '.git', 'config'), join(root, 'cfg.txt'))
      await redactWorktree(root)
      await expect(lstat(join(root, 'cfg.txt'))).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a symlink to a file outside the checkout, never copying the file in', async () => {
    const { symlink, lstat } = await import('node:fs/promises')
    const outside = await mkdtemp('/tmp/maestro-quality-target-')
    const root = await mkdtemp('/tmp/maestro-quality-')
    try {
      await writeFile(join(outside, 'environ'), 'LLM_KEY=abc-not-a-known-format\n')
      await symlink(join(outside, 'environ'), join(root, 'notes.txt'))
      await writeFile(join(root, 'real.php'), "'password' => 'hunter2'\n")
      await symlink(join(root, 'real.php'), join(root, 'alias.php'))
      await redactWorktree(root)
      await expect(lstat(join(root, 'notes.txt'))).rejects.toThrow(/ENOENT/)
      expect((await lstat(join(root, 'alias.php'))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(root, 'alias.php'), 'utf8')).toContain('[REDACTED:env-secret]')
      expect(await readFile(join(outside, 'environ'), 'utf8')).toContain('abc-not-a-known-format')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('a line past the end of a new file', () => {
  const posted = async (line: number) => {
    const { postReviewFindings } = await import('../src/host/forge/gitlab/mr-api.js')
    const calls: { body: string }[] = []
    await postReviewFindings([{ status: 'new', body: 'x', path: 'src/A.php', line, severity: 'major', code: 'BUG-X' }], {
      baseUrl: 'https://g', token: 't', projectId: 1, mrIid: 2,
      fetcher: ((_u: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return Promise.resolve({ ok: true }) }) as typeof fetch,
      snapshot: Promise.resolve({ diffRefs: { base_sha: 'b', start_sha: 's', head_sha: 'h' }, changes: [{ old_path: 'src/A.php', new_path: 'src/A.php', new_file: true, diff: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' }] }),
    } as never)
    return calls[0].body
  }

  it('says the line does not exist instead of claiming it is outside the diff', async () => {
    const body = await posted(4090)
    expect(body).toMatch(/^\*\*Inline fallback — `src\/A\.php:4090` is past the end of the file \(3 lines\)\*\*/)
    expect(body).not.toMatch(/not in current MR diff/)
  })
})

describe('finding codes', () => {
  const tool = async () => {
    const { apply } = await import('../src/host/review-findings-tool.js')
    let tool: any
    const reports: unknown[][] = []
    apply({ tools: { register: (t: unknown) => { tool = t } } } as any, { onReport: (f) => reports.push(f) })
    return { run: (findings: unknown[]) => tool.execute({ findings }), reports }
  }

  it('sends a report with an uncoded new finding back once, naming the finding', async () => {
    const t = await tool()
    await expect(t.run([{ status: 'new', path: 'a', line: 1, body: 'x', code: 'BUG-A' }, { status: 'new', path: 'a', line: 2, body: 'y' }])).rejects.toThrow(/finding 2.*code/)
  })

  it('accepts the second attempt even without codes, so a review is never lost', async () => {
    const t = await tool()
    await expect(t.run([{ status: 'new', path: 'a', line: 2, body: 'y' }])).rejects.toThrow()
    await expect(t.run([{ status: 'new', path: 'a', line: 2, body: 'y' }])).resolves.toEqual({ received: 1 })
  })

  it('never asks a reply for a code', async () => {
    const t = await tool()
    await expect(t.run([{ status: 'reply', discussionId: 'd', body: 'y' }])).resolves.toEqual({ received: 1 })
  })
})

describe('final review fixes: finding codes', () => {
  const tool = async (requireCodes?: boolean) => {
    const { apply } = await import('../src/host/review-findings-tool.js')
    let t: any
    const reports: unknown[][] = []
    apply({ tools: { register: (x: unknown) => { t = x } } } as any, { onReport: (f) => reports.push(f), ...(requireCodes === undefined ? {} : { requireCodes }) })
    return { run: (findings: unknown[]) => t.execute({ findings }), reports }
  }

  it('records the uncoded report provisionally, so a reviewer that never resends loses nothing', async () => {
    const t = await tool()
    await expect(t.run([{ status: 'new', path: 'a', line: 2, body: 'y', severity: 'blocking' }])).rejects.toThrow(/provisionally/)
    expect(t.reports).toHaveLength(1)
  })

  it('does not ask a discussion-scope reviewer for codes', async () => {
    const t = await tool(false)
    await expect(t.run([{ status: 'new', path: 'a', line: 2, body: 'y' }])).resolves.toEqual({ received: 1 })
  })
})

describe('deleted-file fallback header', () => {
  it('names path and line so the thread can be listed again', async () => {
    const { postReviewFindings } = await import('../src/host/forge/gitlab/mr-api.js')
    const calls: { body: string }[] = []
    await postReviewFindings([{ status: 'new', body: 'x', path: 'old/A.php', line: 7, severity: 'minor', code: 'BUG-X' }], {
      baseUrl: 'https://g', token: 't', projectId: 1, mrIid: 2,
      fetcher: ((_u: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return Promise.resolve({ ok: true }) }) as typeof fetch,
      snapshot: Promise.resolve({ diffRefs: { base_sha: 'b', start_sha: 's', head_sha: 'h' }, changes: [{ old_path: 'old/A.php', new_path: 'old/A.php', deleted_file: true, diff: '@@ -1,1 +0,0 @@\n-a' }] }),
    } as never)
    expect(calls[0].body).toMatch(/^\*\*Inline fallback — `old\/A\.php:7` was deleted in this MR/)
  })
})

describe('outside diff rule', () => {
  it('limits findings on unchanged files to ones tied to the MR goal, in a full review only', () => {
    const full = reviewerPromptParts({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: null } as any).stable.join('')
    expect(full).toMatch(/OUTSIDE DIFF RULE/)
    expect(full).toMatch(/does not change/)
    expect(full).toMatch(/incomplete/)
    expect(full).toMatch(/caller/)
    const discussion = reviewerPromptParts({ scopeKind: 'discussion', mode: 'quick', profileInstruction: '', lint: null, discussionId: 'd', path: 'a', line: 1 } as any).stable.join('')
    expect(discussion).not.toMatch(/OUTSIDE DIFF RULE/)
  })
})

describe('convention rule', () => {
  it('backs a consistency finding with what most comparable code does, and drops it when the code is mixed', () => {
    for (const scopeKind of ['full', 'discussion'] as const) {
      const t = reviewerPromptParts({ scopeKind, mode: 'quick', profileInstruction: '', lint: null, discussionId: 'd', path: 'a', line: 1 } as any).stable.join('')
      expect(t).toMatch(/CONVENTION RULE/)
      expect(t).toMatch(/most comparable code/)
      expect(t).toMatch(/count/)
      expect(t).toMatch(/mixed/)
    }
  })
})
