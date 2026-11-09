import hljs from '../vendor/highlight/core.min.js'
import typescript from '../vendor/highlight/languages/typescript.min.js'
import javascript from '../vendor/highlight/languages/javascript.min.js'
import json from '../vendor/highlight/languages/json.min.js'
import yaml from '../vendor/highlight/languages/yaml.min.js'
import bash from '../vendor/highlight/languages/bash.min.js'
import shell from '../vendor/highlight/languages/shell.min.js'
import css from '../vendor/highlight/languages/css.min.js'
import scss from '../vendor/highlight/languages/scss.min.js'
import less from '../vendor/highlight/languages/less.min.js'
import xml from '../vendor/highlight/languages/xml.min.js'
import markdown from '../vendor/highlight/languages/markdown.min.js'
import python from '../vendor/highlight/languages/python.min.js'
import go from '../vendor/highlight/languages/go.min.js'
import rust from '../vendor/highlight/languages/rust.min.js'
import java from '../vendor/highlight/languages/java.min.js'
import kotlin from '../vendor/highlight/languages/kotlin.min.js'
import csharp from '../vendor/highlight/languages/csharp.min.js'
import php from '../vendor/highlight/languages/php.min.js'
import ruby from '../vendor/highlight/languages/ruby.min.js'
import sql from '../vendor/highlight/languages/sql.min.js'
import dockerfile from '../vendor/highlight/languages/dockerfile.min.js'
import ini from '../vendor/highlight/languages/ini.min.js'
import makefile from '../vendor/highlight/languages/makefile.min.js'
import nginx from '../vendor/highlight/languages/nginx.min.js'
import diff from '../vendor/highlight/languages/diff.min.js'
import plaintext from '../vendor/highlight/languages/plaintext.min.js'

const LANGUAGES = { typescript, javascript, json, yaml, bash, shell, css, scss, less, xml, markdown, python, go, rust, java, kotlin, csharp, php, ruby, sql, dockerfile, ini, makefile, nginx, diff, plaintext }
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition)

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
  if (!language || lines.length > MAX_LINES || lines.some((line) => line.length > MAX_LINE_LENGTH)) return lines.map(escapeHtml)
  let html: string
  try {
    html = hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value
  } catch {
    return lines.map(escapeHtml)
  }
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
