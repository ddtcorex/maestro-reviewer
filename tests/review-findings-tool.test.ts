import { describe, expect, it } from 'vitest'
import { FINDINGS_PARAMETERS, normalizeFindings, type ReviewFinding } from '../src/host/review-findings-tool.js'

const base: ReviewFinding = { status: 'new', path: 'a.php', line: 3, body: 'x', severity: 'major', code: 'BUG-X' }

describe('normalizeFindings premise and evidence', () => {
  it('keeps a valid premise', () => {
    expect(normalizeFindings([{ ...base, premise: 'external' }])[0].premise).toBe('external')
  })

  it('drops an unknown premise but keeps the finding', () => {
    const [f] = normalizeFindings([{ ...base, premise: 'vendor' as never }])
    expect(f).toBeDefined()
    expect('premise' in f).toBe(false)
    expect(f.body).toBe('x')
  })

  it('keeps valid evidence', () => {
    expect(normalizeFindings([{ ...base, evidence: [{ path: 'a.php', line: 3 }] }])[0].evidence).toEqual([{ path: 'a.php', line: 3 }])
  })

  it('drops evidence that is not an array', () => {
    const [f] = normalizeFindings([{ ...base, evidence: 'a.php:3' as never }])
    expect('evidence' in f).toBe(false)
  })

  it('drops malformed evidence entries and keeps the rest', () => {
    const [f] = normalizeFindings([{ ...base, evidence: [{ path: 1, line: 3 }, { path: 'a.php', line: 2.5 }, { path: 'a.php', line: 0 }, { path: 'b.php', line: 7 }] as never }])
    expect(f.evidence).toEqual([{ path: 'b.php', line: 7 }])
  })

  it('drops evidence with no valid entry', () => {
    const [f] = normalizeFindings([{ ...base, evidence: [{ path: 'a.php', line: -1 }] }])
    expect('evidence' in f).toBe(false)
  })
})

describe('report_review_findings schema', () => {
  const props = FINDINGS_PARAMETERS.findings.items.properties as Record<string, { type: string; enum?: string[]; items?: { properties: Record<string, { type: string }> } }>

  it('declares premise with its two values', () => {
    expect(props.premise).toMatchObject({ type: 'string', enum: ['checkout', 'external'] })
  })

  it('declares evidence as an array of path and line', () => {
    expect(props.evidence.type).toBe('array')
    expect(props.evidence.items?.properties.path.type).toBe('string')
    expect(props.evidence.items?.properties.line.type).toBe('number')
  })

  it('does not expose engine-only fields', () => {
    expect(props.threadSeverity).toBeUndefined()
    expect(props.severityNote).toBeUndefined()
    expect(props.premiseBy).toBeUndefined()
  })
})

describe('reply resolution', () => {
  const props = FINDINGS_PARAMETERS.findings.items.properties as Record<string, { type: string; enum?: string[] }>
  it('lets a reply say whether its finding is fixed or still open', () => {
    expect(props.resolution).toMatchObject({ type: 'string', enum: ['open', 'fixed'] })
  })
  it('keeps a valid resolution on a reply only', () => {
    const [reply, unknown, onNew] = normalizeFindings([
      { status: 'reply', discussionId: 'd', body: 'x', resolution: 'fixed' },
      { status: 'reply', discussionId: 'd', body: 'x', resolution: 'done' as never },
      { status: 'new', path: 'a.php', line: 1, body: 'x', code: 'BUG-X', resolution: 'fixed' },
    ])
    expect(reply.resolution).toBe('fixed')
    expect('resolution' in unknown).toBe(false)
    expect('resolution' in onNew).toBe(false)
  })
})
