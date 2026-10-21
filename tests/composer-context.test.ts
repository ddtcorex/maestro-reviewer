import { describe, expect, it, vi } from 'vitest'
import { checkDbSchemaWhitelist, detectFrameworkVersions, frameworkContextLine, whitelistFindings } from '../src/host/composer-context.js'
import { reviewerPromptParts } from '../src/host/orchestrator.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})

const lock = {
  packages: [
    { name: 'magento/product-community-edition', version: '2.4.7-p3' },
    { name: 'hyva-themes/magento2-default-theme', version: '1.3.9' },
    { name: 'symfony/console', version: 'v6.4.1' },
  ],
  'packages-dev': [],
  platform: { php: '~8.2.0' },
}

describe('detectFrameworkVersions', () => {
  it('reads Magento, Hyva and PHP from a lock, and constraints from composer.json', () => {
    expect(detectFrameworkVersions(lock)).toEqual({ magento: '2.4.7-p3', hyva: '1.3.9', php: '~8.2.0' })
    expect(detectFrameworkVersions({ packages: [{ name: 'magento/magento2-base', version: '2.4.6' }] })).toEqual({ magento: '2.4.6' })
    expect(detectFrameworkVersions(undefined)).toEqual({})
    expect(detectFrameworkVersions('nonsense')).toEqual({})
    expect(detectFrameworkVersions(undefined, { require: { 'magento/framework': '103.0.*', php: '~8.1.0||~8.2.0', 'hyva-themes/magento2-default-theme': '^1.3' } }))
      .toEqual({ magentoFramework: '103.0.*', php: '~8.1.0||~8.2.0', hyva: '^1.3' })
  })

  it('renders one context line, none when nothing is known', () => {
    expect(frameworkContextLine({ magento: '2.4.7-p3', hyva: '1.3.9', php: '~8.2.0' })).toBe('FRAMEWORK CONTEXT (composer, MR head): Magento 2.4.7-p3, Hyvä 1.3.9, PHP ~8.2.0. Prefer APIs and patterns that exist in these versions.')
    expect(frameworkContextLine({ magentoFramework: '103.0.*' })).toContain('magento/framework 103.0.*')
    expect(frameworkContextLine({})).toBeUndefined()
  })
})

describe('checkDbSchemaWhitelist', () => {
  it('flags a module whose db_schema.xml changed without its whitelist', () => {
    expect(checkDbSchemaWhitelist([
      'app/code/Acme/Shop/etc/db_schema.xml',
      'app/code/Acme/Blog/etc/db_schema.xml', 'app/code/Acme/Blog/etc/db_schema_whitelist.json',
      'etc/db_schema.xml',
    ])).toEqual([{ module: 'app/code/Acme/Shop' }, { module: '.' }])
  })

  it('becomes a major finding on the schema file', () => {
    const [f] = whitelistFindings([{ module: 'app/code/Acme/Shop' }])
    expect(f).toMatchObject({ status: 'new', path: 'app/code/Acme/Shop/etc/db_schema.xml', line: 1, code: 'MAGENTO-DB-WHITELIST', severity: 'minor' })
    expect(f.body).toContain('setup:db-declaration:generate-whitelist')
  })
})

describe('prompt', () => {
  it('puts the framework line in the per-MR part only', () => {
    const parts = reviewerPromptParts({ scopeKind: 'full', mode: 'quick', profileInstruction: '', lint: null, frameworkLine: 'FRAMEWORK CONTEXT (composer, MR head): Magento 2.4.7.' })
    expect(parts.dynamic.join('')).toContain('Magento 2.4.7')
    expect(parts.stable.join('')).not.toContain('FRAMEWORK')
  })
})

describe('engine', () => {
  it('reads composer files at the head, passes the line to the reviewer and posts the whitelist finding', async () => {
    const reads: string[] = []
    const posted: any[] = []
    const forge = {
      mrHeadSha: async () => 'abc', mrBaseSha: async () => 'b', compare: async () => undefined, restrictToInterdiff: () => {}, feedback: async () => new Map(),
      reviewScope: async () => ({ files: [{ path: 'app/code/Acme/Shop/etc/db_schema.xml', bytes: 10 }], skipped: ['composer.lock'] }),
      readFile: async (path: string, ref: string) => { reads.push(`${path}@${ref}`); return path === 'composer.lock' ? JSON.stringify(lock) : undefined },
      postNote: async () => {}, replyToDiscussion: async () => {}, postFindings: async (fs: any[]) => { posted.push(...fs) },
      signals: () => ({ start: async () => {}, finish: async () => {} }), mountAgentTools: async () => {},
    }
    let seen: any
    const { createReviewEngine } = await import('../src/host/engine.js')
    await createReviewEngine({} as any, { reviewer: vi.fn(async (_w: unknown, _p: unknown, run: any) => { seen = run; return { summary: 'ok', failures: [] } }), auditor: vi.fn() } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'abc', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' }, reviewProfile: 'magento2' } as any,
      { gitlab: { baseUrl: 'https://g', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000, forge: forge as any },
    )
    expect(reads).toEqual(['composer.lock@abc'])
    expect(seen.frameworkLine).toContain('Magento 2.4.7-p3')
    expect(posted.map((f) => f.code)).toEqual(['MAGENTO-DB-WHITELIST'])
  })
})
