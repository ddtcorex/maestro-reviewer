import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : []
  })
}

/** Every tool name passed to defineTool anywhere in src/host. */
function definedTools(): string[] {
  const names = new Set<string>()
  for (const file of sources(HOST)) {
    for (const m of readFileSync(file, 'utf-8').matchAll(/defineTool\(\{\s*name:\s*'([a-z][a-z0-9_]*)'/g)) names.add(m[1])
  }
  return [...names].sort()
}

describe('review agent tool surface', () => {
  it('is exactly the tools still in use; adding or dropping one is a deliberate change here', () => {
    expect(definedTools()).toEqual([
      'gitlab_get_file_diff',
      'gitlab_get_mr_diff',
      'gitlab_list_own_review_threads',
      'gitlab_post_inline_comment',
      'gitlab_post_mr_comment',
      'gitlab_reply_to_thread',
      'hyva_csp_scan',
      'hyva_theme_inspect',
      'layout_xml_extract',
      'maestro_load_review_profile',
      'maestro_perf_log_stats',
      'maestro_review_scope_split',
      'magento_module_check',
      'phtml_escape_scan',
      'report_review_findings',
    ])
  })
})
