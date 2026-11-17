// Types for the vendored highlight.js modules, which ship without declarations.
declare module '*/highlight/core.min.js' {
  const hljs: {
    registerLanguage(name: string, definition: unknown): void
    getLanguage(name: string): unknown
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string }
  }
  export default hljs
}

declare module '*.min.js' {
  const language: unknown
  export default language
}

declare module '*/marked/marked.esm.js' {
  type MarkedToken = {
    type: string
    raw?: string
    text?: string
    href?: string
    ordered?: boolean
    checked?: boolean
    tokens?: MarkedToken[]
    items?: MarkedToken[]
    header?: { tokens: MarkedToken[] }[]
    rows?: { tokens: MarkedToken[] }[][]
  }
  export function lexer(source: string): MarkedToken[]
}
