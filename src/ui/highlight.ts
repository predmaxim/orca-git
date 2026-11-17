import hljs from '../vendor/highlight/core.min.js'
type Grammar = Parameters<typeof hljs.registerLanguage>[1]
// Each loads when a file of its language is shown: a tab loads 23 files instead of 49 each time Orca makes it anew, and the
// widest level of its module graph is 8, not 34. Orca answers 503 to a plugin past 32 requests at once, which fails the whole
// graph (stablyai/orca#43532): the 26 grammars in it left the tab blank now and then.
const GRAMMARS: Record<string, () => Promise<{ default: Grammar }>> = {
  typescript: () => import('../vendor/highlight/languages/typescript.min.js'),
  javascript: () => import('../vendor/highlight/languages/javascript.min.js'),
  json: () => import('../vendor/highlight/languages/json.min.js'),
  yaml: () => import('../vendor/highlight/languages/yaml.min.js'),
  bash: () => import('../vendor/highlight/languages/bash.min.js'),
  shell: () => import('../vendor/highlight/languages/shell.min.js'),
  css: () => import('../vendor/highlight/languages/css.min.js'),
  scss: () => import('../vendor/highlight/languages/scss.min.js'),
  less: () => import('../vendor/highlight/languages/less.min.js'),
  xml: () => import('../vendor/highlight/languages/xml.min.js'),
  markdown: () => import('../vendor/highlight/languages/markdown.min.js'),
  python: () => import('../vendor/highlight/languages/python.min.js'),
  go: () => import('../vendor/highlight/languages/go.min.js'),
  rust: () => import('../vendor/highlight/languages/rust.min.js'),
  java: () => import('../vendor/highlight/languages/java.min.js'),
  kotlin: () => import('../vendor/highlight/languages/kotlin.min.js'),
  csharp: () => import('../vendor/highlight/languages/csharp.min.js'),
  php: () => import('../vendor/highlight/languages/php.min.js'),
  ruby: () => import('../vendor/highlight/languages/ruby.min.js'),
  sql: () => import('../vendor/highlight/languages/sql.min.js'),
  dockerfile: () => import('../vendor/highlight/languages/dockerfile.min.js'),
  ini: () => import('../vendor/highlight/languages/ini.min.js'),
  makefile: () => import('../vendor/highlight/languages/makefile.min.js'),
  nginx: () => import('../vendor/highlight/languages/nginx.min.js'),
  diff: () => import('../vendor/highlight/languages/diff.min.js'),
  plaintext: () => import('../vendor/highlight/languages/plaintext.min.js')
}
/** The grammars a grammar hands parts of its text to (`subLanguage` in the vendor files), loaded with it. */
const EMBEDS: Record<string, string[]> = {
  typescript: ['css', 'xml'],
  javascript: ['css', 'xml'],
  xml: ['css', 'javascript'],
  markdown: ['xml'],
  dockerfile: ['bash'],
  shell: ['bash'],
  yaml: ['ruby']
}
const loaded = new Map<string, Promise<boolean>>()

/** Registers one grammar; false when it failed to load, and a later call tries again. */
function loadGrammar(language: string): Promise<boolean> {
  let done = loaded.get(language)
  if (!done) {
    done = GRAMMARS[language]().then(
      (grammar) => (hljs.registerLanguage(language, grammar.default), true),
      () => (loaded.delete(language), false)
    )
    loaded.set(language, done)
  }
  return done
}

/** Registers the grammar `language` and those it embeds, at any depth; true when it is there to highlight with, false for none or one that failed to load. */
export async function loadLanguage(language: string | null): Promise<boolean> {
  if (!language || !GRAMMARS[language]) return false
  const all = new Set([language])
  for (const name of all) for (const embed of EMBEDS[name] ?? []) all.add(embed)
  // An embedded grammar that failed leaves its part plain: hljs skips a sub-language it does not know.
  const [own] = await Promise.all([...all].map(loadGrammar))
  return own
}

const MAX_LINES = 5000
const MAX_LINE_LENGTH = 2000

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', markdown: 'markdown',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', cs: 'csharp',
  php: 'php', rb: 'ruby', sql: 'sql', ini: 'ini', toml: 'ini', conf: 'nginx', diff: 'diff', patch: 'diff', mk: 'makefile'
}
const NAMES: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile' }

/** The highlight.js language for a file path, or null when it is not known. */
export function languageFor(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (NAMES[name]) return NAMES[name]
  const dot = name.lastIndexOf('.')
  return dot > 0 || (dot === 0 && name.length > 1) ? (EXTENSIONS[name.slice(dot + 1)] ?? null) : null
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** HTML for each line; a token that runs over a line break is closed at its end and reopened on the next line. */
export function highlightLines(lines: string[], language: string | null): string[] {
  // A grammar not loaded yet (loadLanguage) shows the text plain.
  if (!language || !hljs.getLanguage(language) || lines.length > MAX_LINES || lines.some((line) => line.length > MAX_LINE_LENGTH)) return lines.map(escapeHtml)
  let html: string
  try {
    html = hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value
  } catch {
    return lines.map(escapeHtml)
  }
  // A comment opening with /** is a doc comment, which WebStorm colors apart from the others.
  html = html.replace(/<span class="hljs-comment">\/\*\*(?!\/)/g, '<span class="hljs-comment hljs-doc">/**')
  const open: string[] = []
  return html.split('\n').map((line) => {
    const prefix = open.join('')
    for (const [tag] of line.matchAll(/<\/?span[^>]*>/g)) {
      if (tag.startsWith('</')) open.pop()
      else open.push(tag)
    }
    return prefix + line + '</span>'.repeat(open.length)
  })
}

/** Wraps the characters `[start, end)` of the line's text (an entity counts as one) in `<span class="cls">`, splitting tokens at the edges. */
export function markRange(html: string, start: number, end: number, cls: string): string {
  let out = ''
  let pos = 0
  let open = false
  const close = () => {
    if (open) out += '</span>'
    open = false
  }
  for (const [part] of html.matchAll(/<[^>]*>|&#?\w+;|[^<&]|&/g)) {
    if (part.startsWith('<')) {
      close()
      out += part
      continue
    }
    const inside = pos >= start && pos < end
    if (inside && !open) {
      out += `<span class="${cls}">`
      open = true
    } else if (!inside) close()
    out += part
    pos++
  }
  close()
  return out
}
