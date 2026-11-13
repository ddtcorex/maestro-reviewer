import { describe, expect, it, vi } from 'vitest'
import { checkEvidence, classifyPremise, premiseSource, saysVendorMissing } from '../src/host/finding-filters.js'
import type { ReviewFinding } from '../src/host/review-findings-tool.js'

describe('saysVendorMissing', () => {
  it.each([
    'The vendor/parent-theme file is not in this checkout, so I could not confirm it.',
    '`vendor/` is an empty placeholder in this checkout, so I could not read the lifecycle.',
    'There is no vendor/ in this checkout, so this is a question, not a claim.',
    'I could not verify the framework behaviour without the vendor source.',
  ])('matches the real phrasing %#', (body) => {
    expect(saysVendorMissing(body)).toBe(true)
  })

  it.each([
    'The vendor source is not available here, so the plugin order is assumed.',
    'The framework code is not present in the repository, so this is unverified.',
  ])('matches an absence of source anchored to the checkout %#', (body) => {
    expect(saysVendorMissing(body)).toBe(true)
  })

  it.each([
    'The framework escaper is not in use here; the value is echoed raw.',
    'The library call is not in a transaction, so a failure leaves half the rows written.',
    'This third-party payload is not in the allowlist, so it is rejected.',
    'The core check is not present on the admin route.',
    'The migration for this column is not included in the repository, so deploys fail.',
    'The db_schema_whitelist.json entry is not present in this repository; setup:upgrade will drop the column.',
    'The translation key is not present in the repo i18n file.',
    'The new class is not available in this checkout: the import will fatal.',
    'The library code path is not readable by the cron user.',
  ])('does not match a checkout defect that only says something is not in or present %#', (body) => {
    expect(saysVendorMissing(body)).toBe(false)
  })

  it('does not match a plain question', () => {
    expect(saysVendorMissing('Is the quote always saved after collectTotals()?')).toBe(false)
  })

  it('ignores phrases inside a fenced code block', () => {
    expect(saysVendorMissing('See:\n```php\n// vendor is not in this checkout\n```\nThe loop is wrong.')).toBe(false)
  })
})

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({ status: 'new', path: 'a.php', line: 3, body: 'The loop skips the last item.', severity: 'major', code: 'BUG-X', ...over })

describe('classifyPremise', () => {
  it('trusts a declared external premise', () => {
    expect(classifyPremise(finding({ premise: 'external' }))).toBe('external')
  })

  it('overrides a declared checkout premise when the body says the vendor is missing', () => {
    expect(classifyPremise(finding({ premise: 'checkout', body: 'The vendor source is not in this checkout, please confirm.' }))).toBe('external')
  })

  it('defaults to checkout when undeclared and silent', () => {
    expect(classifyPremise(finding())).toBe('checkout')
  })
})

describe('premiseSource', () => {
  it('names who called the premise external', () => {
    const vendor = 'The vendor source is not in this checkout, please confirm.'
    expect(premiseSource(finding({ premise: 'external' }))).toBe('model')
    expect(premiseSource(finding({ body: vendor }))).toBe('text')
    expect(premiseSource(finding({ premise: 'external', body: vendor }))).toBe('both')
    expect(premiseSource(finding())).toBeUndefined()
  })
})

describe('checkEvidence', () => {
  const tenLines = vi.fn(async (path: string) => (path === 'a.php' ? 10 : undefined))

  it('keeps major with evidence inside the file', async () => {
    const f = await checkEvidence(finding({ evidence: [{ path: 'a.php', line: 3 }] }), tenLines)
    expect(f.severity).toBe('major')
    expect(f.severityNote).toBeUndefined()
  })

  it('lowers major when the line is past the end of the file', async () => {
    const f = await checkEvidence(finding({ evidence: [{ path: 'a.php', line: 11 }] }), tenLines)
    expect(f.severity).toBe('minor')
    expect(f.severityNote).toBe('Severity lowered from major: no evidence in the checkout.')
  })

  it('lowers major when the file is absent', async () => {
    expect((await checkEvidence(finding({ evidence: [{ path: 'b.php', line: 1 }] }), tenLines)).severity).toBe('minor')
  })

  it('lowers major without evidence', async () => {
    expect((await checkEvidence(finding(), tenLines)).severity).toBe('minor')
  })

  it('names blocking in the note', async () => {
    const f = await checkEvidence(finding({ severity: 'blocking' }), tenLines)
    expect(f.severityNote).toBe('Severity lowered from blocking: no evidence in the checkout.')
  })

  it('keeps one valid entry among invalid ones', async () => {
    const f = await checkEvidence(finding({ evidence: [{ path: 'b.php', line: 1 }, { path: 'a.php', line: 10 }] }), tenLines)
    expect(f.severity).toBe('major')
  })

  it('rejects a path that leaves the checkout without reading it', async () => {
    const reader = vi.fn(async () => 1000)
    for (const path of ['../etc/passwd', '/etc/passwd', 'a/../../x.php']) {
      const f = await checkEvidence(finding({ evidence: [{ path, line: 1 }] }), reader)
      expect(f.severity).toBe('minor')
    }
    expect(reader).not.toHaveBeenCalled()
  })

  it('returns a minor unchanged without reading', async () => {
    const reader = vi.fn(async () => 10)
    const f = finding({ severity: 'minor' })
    expect(await checkEvidence(f, reader)).toBe(f)
    expect(reader).not.toHaveBeenCalled()
  })

  it('returns the finding unchanged when files cannot be read', async () => {
    const f = finding()
    expect(await checkEvidence(f, undefined)).toBe(f)
  })
})
