import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDiffSpillPath, writeDiffSpill } from '../src/host/forge/gitlab/gitlab-client.js'

describe('resolveDiffSpillPath', () => {
  it('lands inside the agent workspace root', () => {
    expect(resolveDiffSpillPath('/tmp/maestro-mr-1-2-abc', 3760)).toBe('/tmp/maestro-mr-1-2-abc/.maestro/mr-3760.diff')
  })
})

describe('writeDiffSpill', () => {
  it('writes the full diff text and reports path + bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-spill-'))
    try {
      const text = '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'
      const out = writeDiffSpill(root, 3760, text)
      expect(out.bytes).toBe(Buffer.byteLength(text, 'utf8'))
      expect(readFileSync(join(root, out.path), 'utf8')).toBe(text)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
