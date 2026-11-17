import type { DiffHunk, DiffLine, FileDiff, NoteSide, SelectionFile } from '../shared/protocol.ts'
import { api, errorMessage } from './api.ts'
import { h, icon } from './dom.ts'
import { changeBlocks, changedRange, splitRows, type ChangeKind } from './diffmodel.ts'
import { fileIcon } from './fileicons.ts'
import { shortHash, statusName } from './format.ts'
import { t } from '../shared/i18n.ts'
import { highlightLines, languageFor, loadLanguage, markRange } from './highlight.ts'
import { findKey, withKey } from './keys.ts'
import { mountNotes, type NotesView } from './notes.ts'
import { mountOverview, type OverviewMark } from './overview.ts'

export type DiffMode = 'split' | 'unified'

export interface DiffOptions {
  root: string
  files: SelectionFile[]
  index: number
  mode: DiffMode
  wholeFile: boolean
  /** Called when the user switches layout or context, to remember it. */
  onPrefs(mode: DiffMode, wholeFile: boolean): void
  /** The agent the notes were last sent to, and the call that remembers a new choice. */
  noteAgent?: string
  onNoteAgent(agent: string): void
  /** Called when the user moves to another file with the arrows. */
  onIndex(index: number): void
  /** Called when the note editor closes: saved, cancelled, or its thread gone. */
  onEditorClosed(): void
  /** The id of a note to scroll to once, when the notes and the file are loaded; without one, a note being written in a frame before this one opens again. */
  reveal?: string
  /** Where the first file shown is scrolled to instead of its top: Orca made the tab anew, and this is where the frame before left it. */
  scroll?: number
  /** Called as the file shown scrolls, with its index and whether it shows the whole file. */
  onScroll(top: number, index: number, wholeFile: boolean): void
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

/** HTML per line, highlighted when the language is known: each hunk's old side (context and `-`) and new side (context and `+`) are highlighted on their own. */
function highlightHunks(hunks: DiffHunk[], language: string | null): Map<DiffLine, string> {
  const html = new Map<DiffLine, string>()
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

/** A cell of code; `sides` are the line's numbers on the sides the cell shows, which notes and selections go by. */
function code(line: DiffLine | undefined, sides: Partial<Record<NoteSide, number>>, ranges: Map<DiffLine, [number, number]>, html: Map<DiffLine, string>, notes: NotesView): HTMLElement {
  if (!line) return h('div', { class: 'd-code d-empty' })
  const range = ranges.get(line)
  let marked = html.get(line) ?? ''
  if (range && range[0] !== range[1]) marked = markRange(marked, range[0], range[1], 'word')
  for (const side of ['old', 'new'] as const) {
    const n = sides[side]
    if (n !== undefined) marked = notes.mark(marked, side, n, line.text.length)
  }
  const el = h('div', { class: `d-code ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}`, 'data-old': sides.old, 'data-new': sides.new })
  el.innerHTML = marked || '\u200b'
  return el
}

const num = (value: number | undefined, kind?: string) =>
  h('div', { class: `d-num ${kind === '+' ? 'add' : kind === '-' ? 'del' : ''}` }, value === undefined ? '' : String(value))

const hunkRow = (hunk: DiffHunk) =>
  h('div', { class: 'd-hunk' }, `@@ -${hunk.oldStart} +${hunk.newStart} @@`, hunk.section ? h('span', { class: 'section' }, hunk.section) : null)

const lineSpan = (first: number, last: number) => (first === last ? `${first}` : `${first}–${last}`)
const blockTitle = { added: 'overviewAdded', deleted: 'overviewDeleted', modified: 'overviewModified' } as const

/** The single place that turns hunks into rows; the rows of notes follow the lines they end on. */
function renderLines(diff: FileDiff, mode: DiffMode, notes: NotesView): { rows: HTMLElement[]; blocks: { first: HTMLElement; last: HTMLElement; kind: ChangeKind; title: string }[] } {
  const ranges = wordRanges(diff.hunks)
  const html = highlightHunks(diff.hunks, languageFor(diff.path))
  const rows: HTMLElement[] = []
  // What each row changes, and its line numbers for the title of its block.
  const changed: { add: boolean; del: boolean; old?: number; new?: number }[] = []
  // A note row belongs to the block of the line above it, so F7 does not stop at it.
  const after = (side: NoteSide, line: number | undefined) => {
    if (line === undefined) return
    for (const row of notes.rowsAfter(side, line, mode)) {
      rows.push(row)
      const { add, del } = changed[changed.length - 1]
      changed.push({ add, del })
    }
  }
  for (const hunk of diff.hunks) {
    if (diff.hunks.length > 1 || hunk.oldStart > 1 || hunk.newStart > 1) {
      rows.push(hunkRow(hunk))
      changed.push({ add: false, del: false })
    }
    if (mode === 'split') {
      for (const { left, right } of splitRows(hunk)) {
        const isChange = left?.kind !== ' ' || right?.kind !== ' '
        rows.push(
          h(
            'div',
            { class: `d-row${isChange ? ' change' : ''}` },
            num(left?.old, left?.kind),
            code(left, { old: left?.old }, ranges, html, notes),
            num(right?.new, right?.kind),
            code(right, { new: right?.new }, ranges, html, notes)
          )
        )
        changed.push({ add: right?.kind === '+', del: left?.kind === '-', old: left?.old, new: right?.new })
        after('old', left?.old)
        after('new', right?.new)
      }
    } else {
      for (const line of hunk.lines) {
        rows.push(h('div', { class: `d-row${line.kind === ' ' ? '' : ' change'}` }, num(line.old, line.kind), num(line.new, line.kind), code(line, { old: line.old, new: line.new }, ranges, html, notes)))
        changed.push({ add: line.kind === '+', del: line.kind === '-', old: line.old, new: line.new })
        after('old', line.old)
        after('new', line.new)
      }
    }
  }
  const blocks = changeBlocks(changed).map(({ start, end, kind }) => {
    // A deletion has old numbers only; the rest go by the new side.
    const side = kind === 'deleted' ? 'old' : 'new'
    const numbers = changed.slice(start, end + 1).flatMap((row) => row[side] ?? [])
    return { first: rows[start], last: rows[end], kind, title: t(blockTitle[kind], { lines: lineSpan(numbers[0], numbers[numbers.length - 1]) }) }
  })
  return { rows, blocks }
}

/** Fills the container with the hint shown while no file is open. */
export function showDiffPlaceholder(container: HTMLElement): void {
  container.replaceChildren(h('div', { class: 'diff-view' }, h('div', { class: 'diff-note muted' }, t('diffSelectFile'))))
}

/** Shows `files[index]` in the container and loads the notes; Alt+↑/↓ moves between files, F7 between changes, Ctrl+Shift+A notes the selection. */
export function mountDiff(container: HTMLElement, options: DiffOptions): { notes: NotesView; dispose(): void } {
  const { root, files, onPrefs, onIndex, onNoteAgent } = options
  let index = Math.max(0, Math.min(options.index, files.length - 1))
  let mode = options.mode
  let wholeFile = options.wholeFile
  let diff: FileDiff | null = null
  let changes: HTMLElement[] = []
  let token = 0
  /** A held key moved past files without loading them: the one shown loads when it comes up. */
  let behind = false
  /** Taken by the first load: a later one opens at the top. */
  let restore = options.scroll

  const title = h('div', { class: 'diff-title' })
  const counter = h('span', { class: 'muted' })
  const info = h('div', { class: 'diff-info mono muted' })
  const body = h('div', { class: 'diff-body', tabindex: '-1' })
  // Next to the body, not in it: render() replaces what the body holds.
  const overview = mountOverview(body)
  const notes = mountNotes({
    root,
    files,
    agent: options.noteAgent,
    onAgent: onNoteAgent,
    closed: () => options.onEditorClosed(),
    rerender: () => {
      const top = body.scrollTop
      render()
      body.scrollTop = top
    },
    show: (next, whole, then) => {
      const ready = next === index && (wholeFile || !whole) && diff !== null
      if (next !== index) {
        index = next
        onIndex(index)
      }
      if (whole && !wholeFile) {
        wholeFile = true
        onPrefs(mode, wholeFile)
      }
      if (ready) then()
      else
        void load().then((shown) => {
          if (shown) then()
        })
    }
  })
  const arrow = (name: 'left' | 'right', tip: string, run: () => void) => h('button', { class: 'tool', title: tip, 'aria-label': tip, onclick: run }, icon(name))
  const prevFile = arrow('left', t('diffPrevFile'), () => go(index - 1))
  const nextFile = arrow('right', t('diffNextFile'), () => go(index + 1))
  const splitButton = h('button', { class: 'tool', title: withKey(t('diffSplitTip'), 'layout'), onclick: () => setMode('split') }, t('diffSplit'))
  const unifiedButton = h('button', { class: 'tool', title: withKey(t('diffUnifiedTip'), 'layout'), onclick: () => setMode('unified') }, t('diffUnified'))
  const wholeButton = h('button', { class: 'tool', title: withKey(t('diffWholeFileTip'), 'wholeFile'), onclick: () => setWhole(!wholeFile) }, t('diffWholeFile'))
  const view = h(
    'div',
    { class: 'diff-view' },
    h(
      'div',
      { class: 'diff-header' },
      // The arrow icon is hidden from screen readers: the label says the direction.
      h('button', { class: 'tool', title: t('diffPrevChangeTip'), 'aria-label': t('diffPrevChangeTip'), onclick: () => jump(-1) }, icon('up'), h('span', null, t('diffChange'))),
      h('button', { class: 'tool', title: t('diffNextChangeTip'), 'aria-label': t('diffNextChangeTip'), onclick: () => jump(1) }, icon('down'), h('span', null, t('diffChange'))),
      h('span', { class: 'sep' }),
      prevFile,
      counter,
      nextFile,
      h('span', { class: 'sep' }),
      title,
      h('div', { class: 'spacer' }),
      h('div', { class: 'seg' }, splitButton, unifiedButton),
      wholeButton,
      // The review's own group, last: what the view shows first, then what to do with the notes.
      h('span', { class: 'sep' }),
      ...notes.buttons
    ),
    info,
    h('div', { class: 'diff-main' }, body, overview.el)
  )

  function syncHeader(): void {
    const file = files[index]
    const letter = file.status[0] ?? 'M'
    const path = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path
    title.replaceChildren(
      h('span', { class: `status-letter st-${letter}`, title: statusName(letter) ?? file.status }, letter),
      fileIcon(file.path),
      h('span', { class: 'path', title: path }, h('bdi', { dir: 'ltr' }, path))
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
    const digits = String(Math.max(0, ...diff.hunks.map((x) => Math.max(x.oldStart, x.newStart) + x.lines.length))).length
    const lines = h('div', { class: `diff-lines ${mode}`, style: `--num-w: ${digits + 2}ch` })
    // Also for a file without rows: the notes go by the file shown (the This file group of the send menu).
    notes.attach(lines, diff, files[index], mode)
    const note = (text: string) => h('div', { class: 'diff-note muted' }, text)
    if (diff.binary) {
      body.replaceChildren(note(t('diffBinary')))
      changes = []
      overview.set([])
      return
    }
    if (!diff.hunks.length) {
      body.replaceChildren(note(files[index].oldPath ? t('diffRenamedOnly') : t('diffNoChanges')))
      changes = []
      overview.set([])
      return
    }
    const rendered = renderLines(diff, mode, notes)
    changes = rendered.blocks.map((block) => block.first)
    lines.append(...rendered.rows)
    body.replaceChildren(...(diff.truncated ? [note(t('diffTruncated'))] : []), lines)
    overview.set(wholeFile ? [...rendered.blocks.map(({ first, last, kind, title }) => ({ from: first, to: last, kind, title })), ...noteMarks(lines)] : [])
  }

  /** The marks of the notes shown, from the row of their first line to the row of their last; a note without its rows here has none. */
  function noteMarks(lines: HTMLElement): OverviewMark[] {
    const row = (side: NoteSide, line: number) => lines.querySelector(`.d-code[data-${side}="${line}"]`)?.closest<HTMLElement>('.d-row')
    return notes.visible().flatMap((n): OverviewMark[] => {
      const from = row(n.side, n.start.line)
      const to = row(n.side, n.end.line)
      const text = (n.messages[0]?.body ?? '').split('\n', 1)[0]
      return from && to ? [{ from, to, kind: n.resolvedAt === undefined ? 'note' : 'note-resolved', title: t('overviewNote', { lines: lineSpan(n.start.line, n.end.line), text }) }] : []
    })
  }

  /** Shows the current file's header over the loading note; a load still running for another file is dropped. */
  function clear(): number {
    syncHeader()
    diff = null
    body.replaceChildren(h('div', { class: 'diff-note muted' }, t('diffLoading')))
    overview.set([])
    return ++token
  }

  /** Loads and shows the current file; true when it is shown, not overtaken by another load or failed. */
  async function load(): Promise<boolean> {
    const mine = clear()
    const top = restore
    restore = undefined
    try {
      // The grammar loads with the diff: render() highlights with it, or shows the text plain when it failed.
      const [result] = await Promise.all([api.rangeDiff(root, files[index], wholeFile), loadLanguage(languageFor(files[index].path))])
      if (mine !== token) return false
      diff = result
      render()
      if (top !== undefined) body.scrollTop = top
      else {
        body.scrollTop = 0
        if (wholeFile && changes.length) jump(1, -Infinity)
      }
      return true
    } catch (error) {
      if (mine === token) body.replaceChildren(h('div', { class: 'diff-note error' }, errorMessage(error)))
      return false
    }
  }

  /**
   * Shows the file at `next`. A held key (`held`, the key's repeat) only moves the header: the file it stops on loads when the
   * key comes up, not each one it passes; Orca refuses a plugin more than 120 requests in 10 s, the sidebar's included.
   */
  function go(next: number, held = false): void {
    if (next < 0 || next >= files.length || next === index) return
    index = next
    if (held) {
      clear()
      behind = true
      return
    }
    onIndex(index)
    void load()
  }

  /** The key held over files came up, or the frame lost the keyboard before it did. */
  function settle(): void {
    if (!behind) return
    behind = false
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
    // A menu or popover (.layer), a dialog (.overlay) or the busy spinner owns the keys, as in the panel.
    if (document.querySelector('.busy, .overlay, .layer')) return
    // Leave typing and open dialogs or menus alone; the file tree and commit list still get the shortcuts.
    if (event.defaultPrevented || target?.closest?.('input, textarea, select, [contenteditable], .overlay, .menu') || target?.isContentEditable) return
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    if ((event.altKey && event.key === 'ArrowUp') || (plain && event.key === 'ArrowLeft')) go(index - 1, event.repeat)
    else if ((event.altKey && event.key === 'ArrowDown') || (plain && event.key === 'ArrowRight')) go(index + 1, event.repeat)
    else if (event.key === 'F7') jump(event.shiftKey ? -1 : 1)
    else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyA') {
      if (!notes.addFromSelection()) return
    } else {
      const key = findKey(event, ['diff'])?.id
      if (key === 'layout') setMode(mode === 'split' ? 'unified' : 'split')
      else if (key === 'wholeFile') setWhole(!wholeFile)
      else return
    }
    event.preventDefault()
  }

  document.addEventListener('keydown', onKey)
  document.addEventListener('keyup', settle)
  addEventListener('blur', settle)
  container.replaceChildren(view)
  body.addEventListener('scroll', () => diff && options.onScroll(body.scrollTop, index, wholeFile), { passive: true })
  const shown = load()
  void notes.load()
  // Once the file is shown, reveal finds it loaded and does not load it again; the notes view waits for its list itself.
  const id = options.reveal
  void shown.then((ok) => {
    if (!ok) return
    if (id) notes.reveal(id)
    else notes.restore()
  })
  return {
    notes,
    dispose() {
      token++
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keyup', settle)
      removeEventListener('blur', settle)
      notes.dispose()
      overview.dispose()
    }
  }
}
