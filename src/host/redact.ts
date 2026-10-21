import type { ReviewFinding } from './review-findings-tool.js'

/**
 * Secret and personal data redaction before any model call (spec section 7,
 * F4). Values are replaced by typed placeholders `[REDACTED:<kind>]`; a hit
 * carries its kind and line, never the value, so nothing here can leak it
 * into logs, metadata or comments.
 */

export type RedactionKind = 'private-key' | 'aws-key' | 'gitlab-token' | 'github-token' | 'openai-style-key' | 'jwt' | 'env-secret' | 'email' | 'phone'

export const SECRET_KINDS: ReadonlySet<RedactionKind> = new Set(['private-key', 'aws-key', 'gitlab-token', 'github-token', 'openai-style-key', 'jwt', 'env-secret'])

export interface RedactionHit { kind: RedactionKind; line: number }

const placeholder = (kind: RedactionKind) => `[REDACTED:${kind}]`

/** Each rule rewrites one match, or only the span `value` returns (the value of an assignment). */
interface Rule { kind: RedactionKind; re: RegExp; value?: (m: RegExpExecArray) => { start: number; end: number } | undefined }

const ENV_KEY = '[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*'
const ARRAY_KEY = 'password|passwd|secret|api_key|apikey|token|access_token|private_key|client_secret'

const RULES: Rule[] = [
  { kind: 'jwt', re: /\bey[J][A-Za-z0-9_-]{10,}\.ey[J][A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'gitlab-token', re: /\bgl(?:pat|rt|dt|ptt|ft|soat|oas|cbt)-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'openai-style-key', re: /\bs[k]-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // KEY=value assignments (.env, shell, constants); the value is masked, the key kept.
  {
    kind: 'env-secret',
    // Same-line only ([ \t], never \s): an empty `KEY=` must not take the next line as its value.
    re: new RegExp(`((?<![A-Za-z0-9_])(?:export[ \\t]+)?${ENV_KEY}[ \\t]*[=:][ \\t]*)(['"]?)([^\\s'"#$%{\\[(][^\\s'"#()]*)\\2(?![(\\w.])`, 'g'),
    value: (m) => (/^(?:process\.|getenv|env\b)/.test(m[3]) ? undefined : { start: m.index + m[1].length + m[2].length, end: m.index + m[1].length + m[2].length + m[3].length }),
  },
  // PHP arrays such as Magento's app/etc/env.php: 'password' => 'literal'.
  {
    kind: 'env-secret',
    re: new RegExp(`(['"])(?:${ARRAY_KEY})\\1\\s*=>\\s*(['"])([^'"\\[][^'"]*)\\2`, 'gi'),
    value: (m) => { const start = m.index + m[0].length - 1 - m[3].length; return { start, end: start + m[3].length } },
  },
  { kind: 'email', re: /(?<![A-Za-z0-9._%-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  {
    kind: 'phone',
    re: /(?<!\w)\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\w)/g,
    value: (m) => (m[0].replace(/\D/g, '').length >= 8 ? { start: m.index, end: m.index + m[0].length } : undefined),
  },
]

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/**
 * Pure. Line numbers are those of `text`: a multi-line private key keeps its
 * line breaks (and, with `diff`, each line's diff prefix) so later lines do
 * not move.
 */
export function redact(text: string, opts: { diff?: boolean } = {}): { text: string; hits: RedactionHit[] } {
  const hits: RedactionHit[] = []
  let out = text.replace(PRIVATE_KEY, (block: string, offset: number) => {
    hits.push({ kind: 'private-key', line: lineAt(text, offset) })
    const [, ...rest] = block.split('\n')
    return [placeholder('private-key'), ...rest.map((l) => (opts.diff === true && /^[+\- ]/.test(l) ? l[0] : ''))].join('\n')
  })
  for (const rule of RULES) {
    const source = out
    let rebuilt = ''
    let last = 0
    rule.re.lastIndex = 0
    for (let m = rule.re.exec(source); m !== null; m = rule.re.exec(source)) {
      const span = rule.value ? rule.value(m) : { start: m.index, end: m.index + m[0].length }
      if (span === undefined) continue
      hits.push({ kind: rule.kind, line: lineAt(source, span.start) })
      rebuilt += source.slice(last, span.start) + placeholder(rule.kind)
      last = span.end
    }
    out = rebuilt + source.slice(last)
  }
  return { text: out, hits: hits.sort((a, b) => a.line - b.line) }
}

export interface DiffHit { kind: RedactionKind; added: boolean; line?: number }

/** Pure. Redacts one file's unified diff; an added line's hit carries its new-file line. */
export function redactDiff(diff: string): { diff: string; hits: DiffHit[] } {
  const { text, hits } = redact(diff, { diff: true })
  const newLine: Array<number | undefined> = []
  let n = 0
  for (const l of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { n = Number(h[1]); newLine.push(undefined); continue }
    if (l.startsWith('+') && !l.startsWith('+++')) { newLine.push(n); n++; continue }
    if (l.startsWith(' ')) { n++ }
    newLine.push(undefined)
  }
  const lines = diff.split('\n')
  return {
    diff: text,
    hits: hits.map((h) => {
      const added = lines[h.line - 1]?.startsWith('+') === true && newLine[h.line - 1] !== undefined
      return added ? { kind: h.kind, added, line: newLine[h.line - 1] } : { kind: h.kind, added }
    }),
  }
}

/** One blocking finding per file with an added secret: kinds and lines, never values. */
export function secretFindings(files: Array<{ path: string; hits: DiffHit[] }>): ReviewFinding[] {
  const out: ReviewFinding[] = []
  for (const file of files) {
    const added = file.hits.filter((h) => h.added && h.line !== undefined && SECRET_KINDS.has(h.kind))
    if (added.length === 0) continue
    out.push({
      status: 'new', path: file.path, line: added[0].line, severity: 'blocking', category: 'security', code: 'SEC-SECRET-IN-DIFF',
      body: `This change adds what looks like a secret: ${added.map((h) => `${h.kind} (line ${h.line})`).join(', ')}. The value was redacted before the review. Remove it, rotate it, and load it from the environment or a secret store instead.`,
    })
  }
  return out
}
