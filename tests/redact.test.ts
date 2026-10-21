import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { redact, redactDiff, secretFindings } from '../src/host/redact.js'
import { redactWorktree } from '../src/host/redact-worktree.js'

vi.mock('../src/host/review-history.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/review-history.js')>()
  return { ...mod, recordReviewStart: vi.fn(async () => {}), recordReviewFinish: vi.fn(async () => {}), lastCompletedReview: vi.fn(async () => undefined) }
})
afterEach(() => vi.unstubAllGlobals())

// Built at run time so no token shaped literal sits in the repository.
const j = (...p: string[]) => p.join('')
const SAMPLES: Array<[string, string]> = [
  ['private-key', j('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEow', 'IBAAKCAQEA\n-----END RSA ', 'PRIVATE KEY-----')],
  ['aws-key', j('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
  ['gitlab-token', j('gl', 'pat-', 'abcdefghijklmnopqrstu')],
  ['github-token', j('gh', 'p_', 'a'.repeat(36))],
  ['openai-style-key', j('s', 'k-', 'proj-', 'b'.repeat(30))],
  ['jwt', j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
  ['env-secret', 'DB_PASSWORD=hunter2'],
  ['email', 'jane.doe@example.org'],
  ['phone', '+33 6 12 34 56 78'],
]

describe('redact', () => {
  it('replaces one sample per kind with its typed placeholder and reports the line', () => {
    for (const [kind, sample] of SAMPLES) {
      const { text, hits } = redact(`first line\nvalue: ${sample}\n`)
      expect(text, kind).toContain(`[REDACTED:${kind}]`)
      expect(text, kind).not.toContain(sample.split('\n')[0].slice(-10))
      expect(hits, kind).toEqual([{ kind, line: 2 }])
    }
  })

  it('masks a PHP array secret such as Magento env.php', () => {
    const { text, hits } = redact(`'db' => ['password' => 'S3cr3t!x', 'username' => 'magento']`)
    expect(text).toContain(`'password' => '[REDACTED:env-secret]'`)
    expect(text).toContain(`'username' => 'magento'`)
    expect(hits.map((h) => h.kind)).toEqual(['env-secret'])
  })

  it('leaves ordinary code alone', () => {
    const code = [
      '$email = $customer->getEmail();',
      'private string $password;',
      'if ($password === null) { return; }',
      'DB_PASSWORD=',
      "'password' => $this->config->getPassword(),",
      'id 123e4567-e89b-12d3-a456-426614174000 at 4bbdea55c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5',
      'timestamp 1700000000123 and 2026-10-21',
    ].join('\n')
    expect(redact(code)).toEqual({ text: code, hits: [] })
  })
})

describe('redactDiff', () => {
  it('maps hits on added lines to new-file line numbers and leaves removed lines unflagged', () => {
    const diff = ['@@ -10,3 +10,4 @@', ' context', `-old ${j('gl', 'pat-', 'z'.repeat(20))}`, '+DB_PASSWORD=hunter2', `+mail jane@example.org`, ' tail'].join('\n')
    const r = redactDiff(diff)
    expect(r.diff).not.toContain('hunter2')
    expect(r.diff).not.toContain('jane@example.org')
    expect(r.hits).toEqual([
      { kind: 'gitlab-token', added: false },
      { kind: 'env-secret', added: true, line: 11 },
      { kind: 'email', added: true, line: 12 },
    ])
  })
})

describe('secretFindings', () => {
  it('raises one SEC-SECRET-IN-DIFF finding per file for added secrets only, never with the value', () => {
    const f = secretFindings([
      { path: 'app/etc/env.php', hits: [{ kind: 'env-secret', added: true, line: 7 }, { kind: 'aws-key', added: true, line: 9 }, { kind: 'email', added: true, line: 3 }] },
      { path: 'README.md', hits: [{ kind: 'email', added: true, line: 1 }] },
      { path: 'old.php', hits: [{ kind: 'github-token', added: false }] },
    ])
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ status: 'new', path: 'app/etc/env.php', line: 7, code: 'SEC-SECRET-IN-DIFF', category: 'security', severity: 'blocking' })
    expect(f[0].body).toContain('env-secret (line 7)')
    expect(f[0].body).toContain('aws-key (line 9)')
  })
})

describe('redactWorktree', () => {
  it('rewrites text files in place, skips .git and binaries, and refuses roots outside /tmp/maestro-', async () => {
    const root = mkdtempSync('/tmp/maestro-redact-test-')
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'app/etc'), { recursive: true })
    writeFileSync(join(root, 'app/etc/env.php'), "<?php return ['db' => ['password' => 'S3cr3t!x']];\n")
    writeFileSync(join(root, '.git/config'), 'DB_PASSWORD=hunter2\n')
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x44, 0x42, 0x5f, 0x50]))
    const outside = mkdtempSync('/tmp/maestro-outside-')
    writeFileSync(join(outside, 'secret.env'), 'API_TOKEN=keepme\n')
    symlinkSync(join(outside, 'secret.env'), join(root, 'linked.env'))
    // The symlinked file is replaced by a redacted copy; its target stays as it was.
    expect(await redactWorktree(root)).toEqual({ files: 2, hits: 2 })
    expect(readFileSync(join(root, 'app/etc/env.php'), 'utf8')).toContain('[REDACTED:env-secret]')
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toContain('hunter2')
    expect(readFileSync(join(outside, 'secret.env'), 'utf8')).toContain('keepme')
    await expect(redactWorktree(mkdtempSync('/tmp/other-'))).rejects.toThrow(/refusing/)
    await expect(redactWorktree('/tmp')).rejects.toThrow(/refusing/)
    await expect(redactWorktree('/etc/maestro-x')).rejects.toThrow(/refusing/)
  })
})

describe('the review never shows a secret to the model', () => {
  it('serves redacted diffs, posts the finding and notes the count', async () => {
    const token = j('gl', 'pat-', 'q'.repeat(24))
    const diffs = [
      { old_path: 'app/etc/env.php', new_path: 'app/etc/env.php', diff: `@@ -1,1 +1,2 @@\n line\n+$key = '${token}';\n` },
      { old_path: 'README.md', new_path: 'README.md', diff: '@@ -1 +1 @@\n-x\n+contact jane@example.org\n' },
    ]
    const posts: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 201 }) }
      if (/\/diffs\?/.test(url)) return new Response(JSON.stringify(new URL(url).searchParams.get('page') === '1' ? diffs : []), { status: 200, headers: { 'x-next-page': '' } })
      if (url.endsWith('/versions')) return new Response(JSON.stringify([{ id: 1 }]), { status: 200 })
      if (url.endsWith('/versions/1')) return new Response(JSON.stringify({ base_commit_sha: 'b', start_commit_sha: 'b', head_commit_sha: 'c0ffee', diffs }), { status: 200 })
      if (/\/merge_requests\/2$/.test(url)) return new Response(JSON.stringify({ sha: 'c0ffee', diff_refs: { base_sha: 'b', start_sha: 'b', head_sha: 'c0ffee' } }), { status: 200 })
      return new Response('[]', { status: 200 })
    }))
    const { createReviewEngine } = await import('../src/host/engine.js')
    let served = ''
    const reviewer = vi.fn(async (_w: unknown, _p: unknown, run: any) => {
      const tools: Array<{ name: string; execute: (a: any, e?: any) => Promise<any> }> = []
      await run.forge.mountAgentTools({ plugin: async (mod: any, cfg: any) => mod.apply({ tools: { register: (t: any) => tools.push(t) } }, cfg) }, {})
      for (const p of ['app/etc/env.php', 'README.md']) served += (await tools.find((t) => t.name === 'gitlab_get_file_diff')!.execute({ path: p })).text
      return { summary: '0 new inline comment(s), 0 thread(s) updated.', failures: [] }
    })
    await createReviewEngine({} as any, { reviewer, auditor: vi.fn() } as any).run(
      { projectPath: 'g/p', projectId: 1, mrIid: 2, sourceBranch: 'b', headSha: 'c0ffee', trigger: 'mention', mode: 'quick', scope: { kind: 'mr' } } as any,
      { gitlab: { baseUrl: 'https://git.example.com', token: 't', botUsername: 'bot' }, access: { kind: 'diff' }, model: { provider: 'p', model: 'm' } as any, agentTimeoutMs: 1000 },
    )
    expect(served).not.toContain(token)
    expect(served).not.toContain('jane@example.org')
    expect(served).toContain('[REDACTED:gitlab-token]')
    const all = JSON.stringify(posts)
    expect(all).not.toContain(token)
    const finding = posts.find((p) => /SEC-SECRET-IN-DIFF|secret/i.test(JSON.stringify(p.body)) && p.url.endsWith('/discussions'))
    expect(finding?.body.position).toMatchObject({ new_path: 'app/etc/env.php', new_line: 2 })
    expect(posts.find((p) => p.url.endsWith('/notes'))?.body.body).toContain('2 values redacted before review')
  })
})
