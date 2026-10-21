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
    if (typeof magento === 'string') out.magento = magento
    if (typeof hyva === 'string') out.hyva = hyva
    if (isObject(lock.platform) && typeof lock.platform.php === 'string') out.php = lock.platform.php
    return out
  }
  if (isObject(composerJson) && isObject(composerJson.require)) {
    const req = composerJson.require as Record<string, unknown>
    if (typeof req['magento/framework'] === 'string') out.magentoFramework = req['magento/framework']
    const hyva = HYVA.map((n) => req[n]).find((v) => typeof v === 'string')
    if (typeof hyva === 'string') out.hyva = hyva
    if (typeof req.php === 'string') out.php = req.php
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
      status: 'new', path: `${prefix}etc/db_schema.xml`, line: 1, severity: 'major', category: 'magento', code: 'MAGENTO-DB-WHITELIST',
      body: `This MR changes the declarative schema of \`${module}\` without updating \`${prefix}etc/db_schema_whitelist.json\`. Without the whitelist, setup:upgrade cannot drop or rename what this change removes. Regenerate it with \`bin/magento setup:db-declaration:generate-whitelist --module-name=<Vendor_Module>\` and commit it.`,
    }
  })
}
