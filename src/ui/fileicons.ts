// WebStorm New UI file-type icons (vendored, see src/vendor/jetbrains-icons) for the file tree and the Diff tab.
import { h } from './dom.ts'
import { ICON_SVG } from './fileicons-data.ts'

export const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.dockerignore': 'gitignore',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.gitmodules': 'gitignore',
  '.npmignore': 'gitignore',
  '.editorconfig': 'editorConfig',
  'package.json': 'json',
  'package-lock.json': 'json',
  'tsconfig.json': 'typeScript',
  jenkinsfile: 'jenkins',
  'build.gradle': 'gradle',
  'settings.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'settings.gradle.kts': 'gradle',
  'manifest.mf': 'manifest',
  '.bazelrc': 'bazel',
  'build.bazel': 'bazel',
  workspace: 'bazel',
  readme: 'markdown',
  license: 'text',
  '.env': 'config',
  '.npmrc': 'config',
  '.prettierrc': 'config'
}

export const BY_EXT: Record<string, string> = {
  ts: 'typeScript', tsx: 'typeScript', mts: 'typeScript', cts: 'typeScript',
  js: 'javaScript', jsx: 'javaScript', mjs: 'javaScript', cjs: 'javaScript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', xhtml: 'html',
  vue: 'vue',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  rst: 'rst',
  txt: 'text', log: 'text',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml', wsdl: 'xml',
  properties: 'properties', ini: 'config', conf: 'config', cfg: 'config', env: 'config',
  csv: 'csv', tsv: 'csv',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  bat: 'microsoftWindows', cmd: 'microsoftWindows', ps1: 'microsoftWindows',
  py: 'text', rb: 'text', go: 'text', rs: 'text', lua: 'text',
  java: 'java', kt: 'java', kts: 'gradle', groovy: 'groovy', gradle: 'gradle',
  cs: 'Csharp', c: 'c', h: 'h', hpp: 'h', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  swift: 'swiftLang', pl: 'perl', pm: 'perl',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', http: 'http',
  tf: 'terraform', tfvars: 'terraform', ipynb: 'jupyter', patch: 'patch', diff: 'patch',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', xz: 'archive', bz2: 'archive', '7z': 'archive', rar: 'archive', jar: 'archive',
  bin: 'binaryData', exe: 'binaryData', dll: 'binaryData', so: 'binaryData', wasm: 'binaryData', pdf: 'binaryData'
}

const own = (map: Record<string, string>, key: string): string | undefined => (Object.hasOwn(map, key) ? map[key] : undefined)

/** The icon name for a file path: the whole name first (`Dockerfile`, `.gitignore`), then the extension, else `unknown`. */
export function fileIconName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const byName = own(BY_NAME, name)
  if (byName) return byName
  const dot = name.lastIndexOf('.')
  // A leading dot is a dotfile, not an extension: `.bashrc` has none, `.d.ts` does.
  return (dot > 0 ? own(BY_EXT, name.slice(dot + 1)) : undefined) ?? 'unknown'
}

const dataUrl = (svg: string): string => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

// One <span> per row; its icon is a class from one shared stylesheet, written once per icon name, so rows carry no URLs.
// `html.dark` swaps in the dark variant, so a theme switch needs no redraw.
let sheet: HTMLStyleElement | undefined
const written = new Set<string>()
function themed(name: string): HTMLElement {
  if (!Object.hasOwn(ICON_SVG, name)) name = 'unknown'
  if (!written.has(name)) {
    written.add(name)
    sheet ??= document.head.appendChild(document.createElement('style'))
    const dark = Object.hasOwn(ICON_SVG, `${name}_dark`) ? `html.dark .fi-${name}{background-image:${dataUrl(ICON_SVG[`${name}_dark`])}}` : ''
    sheet.append(`.fi-${name}{background-image:${dataUrl(ICON_SVG[name])}}${dark}`)
  }
  return h('span', { class: `file-icon fi-${name}`, 'aria-hidden': 'true' })
}

export const fileIcon = (path: string): HTMLElement => themed(fileIconName(path))
export const folderIcon = (): HTMLElement => themed('folder')
