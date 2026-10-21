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
