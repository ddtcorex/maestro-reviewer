import type { ReviewFinding } from './review-findings-tool.js'

/**
 * Framework context (spec section 7, F5): Magento, Hyvä and PHP versions
 * read from composer.lock at the MR head (composer.json constraints when
 * there is no lock), for the reviewer prompt; and a deterministic check
 * that a declarative schema change ships its whitelist.
 */

export interface FrameworkVersions { magento?: string; magentoFramework?: string; hyva?: string; php?: string }

const MAGENTO = ['magento/product-community-edition', 'magento/product-enterprise-edition', 'magento/magento2-base']
const HYVA = ['hyva-themes/magento2-default-theme', 'hyva-themes/magento2-theme-module']

/** Version or constraint text only: composer files come from the MR head, so anything else is untrusted prose. */
const VERSION = /^[A-Za-z0-9.*~^|<>=@ ,-]{1,40}$/
const versionText = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v) && !/\s{2}|[a-z]{4}\s[a-z]{3}/i.test(v)

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Pure. A lock wins; composer.json `require` constraints fill in when there is no lock. */
export function detectFrameworkVersions(lock: unknown, composerJson?: unknown): FrameworkVersions {
  const out: FrameworkVersions = {}
  if (isObject(lock)) {
    const packages = [...(Array.isArray(lock.packages) ? lock.packages : []), ...(Array.isArray(lock['packages-dev']) ? lock['packages-dev'] : [])]
      .filter(isObject) as Array<{ name?: unknown; version?: unknown }>
    const version = (names: string[]) => packages.find((p) => names.includes(String(p.name)))?.version
    const magento = version(MAGENTO)
    const hyva = version(HYVA)
    if (versionText(magento)) out.magento = magento
    if (versionText(hyva)) out.hyva = hyva
    if (isObject(lock.platform) && versionText(lock.platform.php)) out.php = lock.platform.php
    return out
  }
  if (isObject(composerJson) && isObject(composerJson.require)) {
    const req = composerJson.require as Record<string, unknown>
    if (versionText(req['magento/framework'])) out.magentoFramework = req['magento/framework']
    const hyva = HYVA.map((n) => req[n]).find(versionText)
    if (versionText(hyva)) out.hyva = hyva
    if (versionText(req.php)) out.php = req.php
  }
  return out
}

/** Pure. One prompt line, or undefined when nothing is known. */
export function frameworkContextLine(v: FrameworkVersions): string | undefined {
  const parts = [
    v.magento !== undefined ? `Magento ${v.magento}` : undefined,
    v.magentoFramework !== undefined ? `magento/framework ${v.magentoFramework}` : undefined,
    v.hyva !== undefined ? `Hyvä ${v.hyva}` : undefined,
    v.php !== undefined ? `PHP ${v.php}` : undefined,
  ].filter((p): p is string => p !== undefined)
  return parts.length === 0 ? undefined : `FRAMEWORK CONTEXT (composer, MR head): ${parts.join(', ')}. Prefer APIs and patterns that exist in these versions.`
}

/** Pure. Module directories whose etc/db_schema.xml changed without their etc/db_schema_whitelist.json. */
export function checkDbSchemaWhitelist(paths: string[]): Array<{ module: string }> {
  const changed = new Set(paths)
  const out: Array<{ module: string }> = []
  for (const p of paths) {
    const m = /^(?:(.*)\/)?etc\/db_schema\.xml$/.exec(p)
    if (m === null) continue
    const module = m[1] ?? '.'
    const prefix = module === '.' ? '' : `${module}/`
    if (!changed.has(`${prefix}etc/db_schema_whitelist.json`)) out.push({ module })
  }
  return out
}

export function whitelistFindings(modules: Array<{ module: string }>): ReviewFinding[] {
  return modules.map(({ module }) => {
    const prefix = module === '.' ? '' : `${module}/`
    return {
      status: 'new', path: `${prefix}etc/db_schema.xml`, line: 1, severity: 'minor', category: 'magento', code: 'MAGENTO-DB-WHITELIST',
      body: `This MR changes the declarative schema of \`${module}\` without updating \`${prefix}etc/db_schema_whitelist.json\`. Adding a table or column works without it, but setup:upgrade only drops or renames what the whitelist lists, so a later removal of what this change adds would silently stay in the database. Regenerate it with \`bin/magento setup:db-declaration:generate-whitelist --module-name=<Vendor_Module>\` and commit it.`,
    }
  })
}
