import { describe, it, expect } from 'vitest'
import { diffFileList, selectFileDiff } from '../src/host/forge/gitlab/gitlab-client.js'

const diffs = [
  { old_path: 'a.php', new_path: 'a.php', diff: '@@ -1 +1 @@\n-x\n+y\n' },
  { old_path: 'b.php', new_path: 'b.php', diff: '@@ -5 +5 @@\n-m\n+n\n' },
]

describe('diffFileList', () => {
  it('lists new paths with byte sizes', () => {
    const files = diffFileList(diffs)
    expect(files.map((f) => f.path)).toEqual(['a.php', 'b.php'])
    expect(files[0].bytes).toBe(Buffer.byteLength(diffs[0].diff, 'utf8'))
  })
})

describe('selectFileDiff', () => {
  it('formats the matching file diff', () => {
    const text = selectFileDiff(diffs, 'b.php')
    expect(text).toContain('--- b.php')
    expect(text).toContain('+++ b.php')
    expect(text).toContain('-m')
  })
  it('returns undefined for an unknown path', () => {
    expect(selectFileDiff(diffs, 'nope.php')).toBeUndefined()
  })
})
