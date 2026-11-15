import { lexer } from '../vendor/marked/marked.esm.js'

export type MdTag = 'p' | 'h4' | 'strong' | 'em' | 'del' | 'code' | 'pre' | 'a' | 'ul' | 'ol' | 'li' | 'blockquote' | 'hr' | 'br' | 'table' | 'tr' | 'th' | 'td'
export type MdNode = string | { tag: MdTag; href?: string; children: MdNode[] }

type Token = ReturnType<typeof lexer>[number]

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const decode = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])

const SAME_TAG = new Set(['strong', 'em', 'del', 'blockquote', 'hr', 'br'])
const SAFE_HREF = /^(?:https?|mailto):/i

/** Adjacent strings become one. */
function push(out: MdNode[], node: MdNode): void {
  const last = out[out.length - 1]
  if (typeof node === 'string' && typeof last === 'string') out[out.length - 1] = last + node
  else if (node !== '') out.push(node)
}

function many(tokens: Token[] | undefined): MdNode[] {
  const out: MdNode[] = []
  for (const t of tokens ?? []) for (const n of one(t)) push(out, n)
  return out
}

function one(t: Token): MdNode[] {
  const { type } = t
  if (SAME_TAG.has(type)) return [{ tag: type as MdTag, children: many(t.tokens) }]
  switch (type) {
    case 'space': return []
    case 'paragraph': return [{ tag: 'p', children: many(t.tokens) }]
    case 'heading': return [{ tag: 'h4', children: many(t.tokens) }]
    case 'codespan': return [{ tag: 'code', children: [t.text ?? ''] }]
    // A code block's text is not escaped by the lexer: it is shown as it is.
    case 'code': return [{ tag: 'pre', children: [{ tag: 'code', children: [t.text ?? ''] }] }]
    case 'list': return [{ tag: t.ordered ? 'ol' : 'ul', children: many(t.items) }]
    case 'list_item': return [{ tag: 'li', children: many(t.tokens) }]
    case 'checkbox': return [t.checked ? '☑ ' : '☐ ']
    case 'table': {
      const row = (cells: { tokens: Token[] }[], tag: 'th' | 'td'): MdNode => ({ tag: 'tr', children: cells.map((c) => ({ tag, children: many(c.tokens) })) })
      return [{ tag: 'table', children: [row(t.header ?? [], 'th'), ...(t.rows ?? []).map((r) => row(r, 'td'))] }]
    }
    case 'link': {
      const children = many(t.tokens)
      return SAFE_HREF.test(t.href ?? '') ? [{ tag: 'a', href: t.href, children }] : children
    }
    case 'image': return [decode(t.text ?? '')]
    case 'text': return t.tokens ? many(t.tokens) : [decode(t.text ?? '')]
    case 'escape': return [t.text ?? '']
    default: return [t.text ?? t.raw ?? '']
  }
}

export function mdTree(source: string): MdNode[] {
  return many(lexer(source))
}

/** The tree as DOM nodes, built with createElement and text nodes only; a link calls `open` instead of navigating. */
export function mdDom(source: string, open: (url: string) => void): DocumentFragment {
  const build = (n: MdNode): Node => {
    if (typeof n === 'string') return document.createTextNode(n)
    const el = document.createElement(n.tag)
    if (n.href !== undefined) {
      const href = n.href
      el.setAttribute('href', href)
      el.setAttribute('rel', 'noreferrer')
      el.addEventListener('click', (e) => {
        e.preventDefault()
        open(href)
      })
    }
    for (const c of n.children) el.append(build(c))
    return el
  }
  const frag = document.createDocumentFragment()
  for (const n of mdTree(source)) frag.append(build(n))
  return frag
}
