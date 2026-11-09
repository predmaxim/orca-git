import type { DiffHunk, DiffLine, FileDiff, SelectionFile } from '../shared/protocol.ts'
import { api, errorMessage } from './api.ts'
import { h, icon } from './dom.ts'
import { changedRange, changeStarts, splitRows } from './diffmodel.ts'
import { shortHash, statusName } from './format.ts'
import { t } from '../shared/i18n.ts'
import { highlightLines, languageFor, markRange } from './highlight.ts'

export type DiffMode = 'split' | 'unified'

export interface DiffOptions {
  root: string
  files: SelectionFile[]
  index: number
  mode: DiffMode
  wholeFile: boolean
  /** Called when the user switches layout or context, to remember it. */
  onPrefs(mode: DiffMode, wholeFile: boolean): void
  /** Called when the user moves to another file with the arrows. */
  onIndex(index: number): void
}

/** Highlight ranges for lines paired with a counterpart: only the changed middle is emphasised. */
function wordRanges(hunks: DiffHunk[]): Map<DiffLine, [number, number]> {
  const ranges = new Map<DiffLine, [number, number]>()
  for (const hunk of hunks) {
    for (const { left, right } of splitRows(hunk)) {
      if (left?.kind !== '-' || right?.kind !== '+' || left.text.length > 2000 || right.text.length > 2000) continue
      const range = changedRange(left.text, right.text)
      if (!range) continue
      ranges.set(left, [range[0], range[1]])
      ranges.set(right, [range[0], range[2]])
    }
  }
  return ranges
}

/** Highlighted HTML per line: each hunk's old side (context and `-`) and new side (context and `+`) are highlighted on their own. */
function highlightHunks(hunks: DiffHunk[], language: string | null): Map<DiffLine, string> {
  const html = new Map<DiffLine, string>()
  if (!language) return html
  for (const hunk of hunks) {
    for (const [side, skip] of [['new', '-'], ['old', '+']] as const) {
      const lines = hunk.lines.filter((line) => line.kind !== skip)
      const result = highlightLines(lines.map((line) => line.text), language)
      // The old pass only fills the lines the new pass does not have.
      lines.forEach((line, i) => (side === 'new' || line.kind === '-') && html.set(line, result[i]))
    }
  }
  return html
}

function code(line: DiffLine | undefined, ranges: Map<DiffLine, [number, number]>, html: Map<DiffLine, string>): HTMLElement {
  if (!line) return h('div', { class: 'd-code d-empty' })
  const range = ranges.get(line)
  const cls = `d-code ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}`
  const colored = html.get(line)
  if (colored !== undefined) {
    const el = h('div', { class: cls })
    const marked = range && range[0] !== range[1] ? markRange(colored, range[0], range[1], 'word') : colored
    el.innerHTML = marked || '\u200b'
    return el
  }
  if (!range || range[0] === range[1]) return h('div', { class: cls }, line.text || '\u200b')
  return h(
    'div',
    { class: cls },
    line.text.slice(0, range[0]),
    h('span', { class: 'word' }, line.text.slice(range[0], range[1])),
    line.text.slice(range[1])
  )
}

const num = (value: number | undefined, kind?: string) =>
  h('div', { class: `d-num ${kind === '+' ? 'add' : kind === '-' ? 'del' : ''}` }, value === undefined ? '' : String(value))

const hunkRow = (hunk: DiffHunk) =>
  h('div', { class: 'd-hunk' }, `@@ -${hunk.oldStart} +${hunk.newStart} @@`, hunk.section ? h('span', { class: 'section' }, hunk.section) : null)

/** The single place that turns hunks into rows. */
function renderLines(diff: FileDiff, mode: DiffMode): { rows: HTMLElement[]; changes: HTMLElement[] } {
  const ranges = wordRanges(diff.hunks)
  const html = highlightHunks(diff.hunks, languageFor(diff.path))
  const rows: HTMLElement[] = []
  const changed: boolean[] = []
  for (const hunk of diff.hunks) {
    if (diff.hunks.length > 1 || hunk.oldStart > 1 || hunk.newStart > 1) {
      rows.push(hunkRow(hunk))
      changed.push(false)
    }
    if (mode === 'split') {
      for (const { left, right } of splitRows(hunk)) {
        const isChange = left?.kind !== ' ' || right?.kind !== ' '
        rows.push(
          h('div', { class: `d-row${isChange ? ' change' : ''}` }, num(left?.old, left?.kind), code(left, ranges, html), num(right?.new, right?.kind), code(right, ranges, html))
        )
        changed.push(isChange)
      }
    } else {
      for (const line of hunk.lines) {
        rows.push(h('div', { class: `d-row${line.kind === ' ' ? '' : ' change'}` }, num(line.old, line.kind), num(line.new, line.kind), code(line, ranges, html)))
        changed.push(line.kind !== ' ')
      }
    }
  }
  return { rows, changes: changeStarts(changed, Boolean).map((i) => rows[i]) }
}

/** Fills the container with the hint shown while no file is open. */
export function showDiffPlaceholder(container: HTMLElement): void {
  container.replaceChildren(h('div', { class: 'diff-view' }, h('div', { class: 'diff-note muted' }, t('diffSelectFile'))))
}

/** Shows `files[index]` in the container; Alt+↑/↓ moves between files, F7 between changes. */
export function mountDiff(container: HTMLElement, options: DiffOptions): { dispose(): void } {
  const { root, files, onPrefs, onIndex } = options
  let index = Math.max(0, Math.min(options.index, files.length - 1))
  let mode = options.mode
  let wholeFile = options.wholeFile
  let diff: FileDiff | null = null
  let changes: HTMLElement[] = []
  let token = 0

  const title = h('div', { class: 'diff-title' })
  const counter = h('span', { class: 'muted' })
  const info = h('div', { class: 'diff-info mono muted' })
  const body = h('div', { class: 'diff-body', tabindex: '-1' })
  const arrow = (label: string, tip: string, run: () => void) => h('button', { class: 'tool', title: tip, 'aria-label': tip, onclick: run }, label)
  const prevFile = arrow('←', t('diffPrevFile'), () => go(index - 1))
  const nextFile = arrow('→', t('diffNextFile'), () => go(index + 1))
  const splitButton = h('button', { class: 'tool', title: t('diffSplitTip'), onclick: () => setMode('split') }, t('diffSplit'))
  const unifiedButton = h('button', { class: 'tool', title: t('diffUnifiedTip'), onclick: () => setMode('unified') }, t('diffUnified'))
  const wholeButton = h('button', { class: 'tool', title: t('diffWholeFileTip'), onclick: () => setWhole(!wholeFile) }, t('diffWholeFile'))
  const view = h(
    'div',
    { class: 'diff-view' },
    h(
      'div',
      { class: 'diff-header' },
      h('button', { class: 'tool', title: t('diffPrevChangeTip'), onclick: () => jump(-1) }, t('diffPrevChange')),
      h('button', { class: 'tool', title: t('diffNextChangeTip'), onclick: () => jump(1) }, t('diffNextChange')),
      h('span', { class: 'sep' }),
      prevFile,
      counter,
      nextFile,
      h('span', { class: 'sep' }),
      title,
      h('div', { class: 'spacer' }),
      splitButton,
      unifiedButton,
      wholeButton
    ),
    info,
    body
  )

  function syncHeader(): void {
    const file = files[index]
    const letter = file.status[0] ?? 'M'
    const path = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path
    title.replaceChildren(
      h('span', { class: `status-letter st-${letter}`, title: statusName(letter) ?? file.status }, letter),
      h('span', { class: 'path', title: path }, path)
    )
    info.textContent = `${file.from ? shortHash(file.from) : t('diffFromEmpty')}..${shortHash(file.to)}  ${path}`
    counter.textContent = t('diffFileCounter', { index: index + 1, count: files.length })
    prevFile.disabled = index === 0
    nextFile.disabled = index === files.length - 1
    splitButton.classList.toggle('on', mode === 'split')
    unifiedButton.classList.toggle('on', mode === 'unified')
    wholeButton.classList.toggle('on', wholeFile)
  }

  function render(): void {
    if (!diff) return
    const note = (text: string) => h('div', { class: 'diff-note muted' }, text)
    if (diff.binary) {
      body.replaceChildren(note(t('diffBinary')))
      changes = []
      return
    }
    if (!diff.hunks.length) {
      body.replaceChildren(note(files[index].oldPath ? t('diffRenamedOnly') : t('diffNoChanges')))
      changes = []
      return
    }
    const digits = String(Math.max(...diff.hunks.map((x) => Math.max(x.oldStart, x.newStart) + x.lines.length))).length
    const rendered = renderLines(diff, mode)
    changes = rendered.changes
    const lines = h('div', { class: `diff-lines ${mode}`, style: `--num-w: ${digits + 2}ch` }, ...rendered.rows)
    body.replaceChildren(...(diff.truncated ? [note(t('diffTruncated'))] : []), lines)
  }

  async function load(): Promise<void> {
    const mine = ++token
    syncHeader()
    diff = null
    body.replaceChildren(h('div', { class: 'diff-note muted' }, t('diffLoading')))
    try {
      const result = await api.rangeDiff(root, files[index], wholeFile)
      if (mine !== token) return
      diff = result
      render()
      body.scrollTop = 0
      if (wholeFile && changes.length) jump(1, -Infinity)
    } catch (error) {
      if (mine === token) body.replaceChildren(h('div', { class: 'diff-note error' }, errorMessage(error)))
    }
  }

  function go(next: number): void {
    if (next < 0 || next >= files.length || next === index) return
    index = next
    onIndex(index)
    void load()
  }

  function setMode(next: DiffMode): void {
    if (next === mode) return
    mode = next
    onPrefs(mode, wholeFile)
    syncHeader()
    render()
  }

  function setWhole(next: boolean): void {
    wholeFile = next
    onPrefs(mode, wholeFile)
    void load()
  }

  /** Scrolls the next or previous block of changes to just below the top of the view. */
  function jump(direction: 1 | -1, from = body.getBoundingClientRect().top + 40): void {
    if (!changes.length) return
    const top = body.getBoundingClientRect().top + 40
    const offsets = changes.map((el) => el.getBoundingClientRect().top - from)
    let i = direction > 0 ? offsets.findIndex((y) => y > 2) : offsets.findLastIndex((y) => y < -2)
    if (i < 0) i = direction > 0 ? 0 : changes.length - 1
    body.scrollTop += changes[i].getBoundingClientRect().top - top
  }

  function onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    // Leave typing and open dialogs or menus alone; the file tree and commit list still get the shortcuts.
    if (event.defaultPrevented || target?.closest?.('input, textarea, select, [contenteditable], .overlay, .menu') || target?.isContentEditable) return
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    if ((event.altKey && event.key === 'ArrowUp') || (plain && event.key === 'ArrowLeft')) go(index - 1)
    else if ((event.altKey && event.key === 'ArrowDown') || (plain && event.key === 'ArrowRight')) go(index + 1)
    else if (event.key === 'F7') jump(event.shiftKey ? -1 : 1)
    else return
    event.preventDefault()
  }

  document.addEventListener('keydown', onKey)
  container.replaceChildren(view)
  void load()
  return {
    dispose() {
      token++
      document.removeEventListener('keydown', onKey)
    }
  }
}
