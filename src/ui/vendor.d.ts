// Types for the vendored highlight.js modules, which ship without declarations.
declare module '*/highlight/core.min.js' {
  const hljs: {
    registerLanguage(name: string, definition: unknown): void
    highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string }
  }
  export default hljs
}

declare module '*.min.js' {
  const language: unknown
  export default language
}
