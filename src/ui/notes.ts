// Review notes in the Diff tab: the selection and its button, the editor, the cards under their lines and the list of all notes.
import type { FileDiff, NoteDraft, NotePoint, NoteSide, NoteVerdict, ReviewNote, SelectionFile } from '../shared/protocol.ts'
import { t, type MessageKey } from '../shared/i18n.ts'
import { MAX_BODY, MAX_QUOTE } from '../shared/notes.ts'
import { api, copyText, errorMessage, orca } from './api.ts'
import type { DiffMode } from './diff.ts'
import { h, icon, ICONS } from './dom.ts'
import { markRange } from './highlight.ts'
import { mdDom } from './markdown.ts'
import { showMenu, showPopover, type MenuEntry } from './menu.ts'
import { anchor, coveredRange, notesOf, notesText, pickSide, sideLines, unsent } from './notemodel.ts'

export interface NotesView {
  /** The header buttons: Notes (N) and, from Task 6, Send to agent (N). */
  buttons: HTMLElement[]
  /** The rows that follow the row of `line` on `side`: the cards of the notes that end there, and the editor when it is open there. */
  rowsAfter(side: NoteSide, line: number, mode: DiffMode): HTMLElement[]
  /** The cell's HTML with the notes' ranges wrapped in <span class="note-mark">. */
  mark(html: string, side: NoteSide, line: number, length: number): string
  /** Each render, before its rows are built: the container of the rows and what it shows. */
  attach(lines: HTMLElement, diff: FileDiff, file: SelectionFile, mode: DiffMode): void
  setNotes(notes: ReviewNote[]): void
  /** Ctrl+Shift+A: opens the editor on the current selection; false when there is none to note. */
  addFromSelection(): boolean
  dispose(): void
}

/** Where a note goes: everything of a draft but its text. */
type Anchor = Omit<NoteDraft, 'body'>

const VERDICT: Record<NoteVerdict, MessageKey> = { confirmed: 'noteConfirmed', refuted: 'noteRefuted', unclear: 'noteUnclear' }

/** Opens a link of a note or an answer outside Orca: http, https and mailto only, whatever the markdown let through. */
function openLink(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') orca.shell?.openExternal(url).catch(() => undefined)
}

const label = (key: MessageKey, tone = '') => h('span', { class: `d-label ${tone}` }, t(key))

/** Not sent, sent, or the verdict of the answer. */
const labels = (n: ReviewNote): HTMLElement[] =>
  n.reply
    ? [label(VERDICT[n.reply.verdict], n.reply.verdict), ...(n.reply.fixed ? [label('noteFixed', 'fixed')] : [])]
    : [label(n.sentAt === undefined ? 'noteUnsent' : 'noteSent')]

const firstLine = (text: string) => text.split('\n', 1)[0]
const lineSpan = (n: ReviewNote) => (n.start.line === n.end.line ? `${n.start.line}` : `${n.start.line}-${n.end.line}`)
/** A cell's text without the placeholder of an empty line. */
const cellText = (text: string) => text.replaceAll('\u200b', '')

/** A selection end as a line and column of `side`: in a cell of the side, else the start of its next line (`forward`) or the end of its previous one. */
function pointOf(lines: HTMLElement, node: Node, offset: number, side: NoteSide, forward: boolean): NotePoint | null {
  const own = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(`.d-code[data-${side}]`)
  if (own) {
    const before = document.createRange()
    before.setStart(own, 0)
    before.setEnd(node, offset)
    return { line: Number(own.dataset[side]), col: cellText(before.toString()).length }
  }
  const at = document.createRange()
  at.setStart(node, offset)
  const cells = Array.from(lines.querySelectorAll<HTMLElement>(`.d-code[data-${side}]`))
  if (!forward) cells.reverse()
  const cell = cells.find((c) => (forward ? at.comparePoint(c, 0) >= 0 : at.comparePoint(c, c.childNodes.length) <= 0))
  return cell ? { line: Number(cell.dataset[side]), col: forward ? 0 : cellText(cell.textContent ?? '').length } : null
}

export function mountNotes(options: {
  root: string
  files: SelectionFile[]
  /** Redraws the rows, keeping the scroll position. */
  rerender(): void
  /** Shows `files[index]`, with the whole file when `whole`, then calls `then`. */
  show(index: number, whole: boolean, then: () => void): void
  /** The agent the notes were last sent to, and the call that remembers a new choice. */
  agent?: string
  onAgent(agent: string): void
}): NotesView {
  const { root, files } = options
  let notes: ReviewNote[] = []
  /** The notes of the diff shown, oldest first. */
  let shown: ReviewNote[] = []
  let container: HTMLElement | null = null
  let diff: FileDiff | null = null
  let file: SelectionFile | null = null
  /** The open editor: a new note at `anchor`, or the note `id`. Its element lives on across renders, and the text with it. */
  let editor: { anchor: Anchor; id?: string; el: HTMLElement; area: HTMLTextAreaElement; error: HTMLElement } | null = null
  let saving = false
  /** A press in the rows is held: the selection is still being made. */
  let pressed = false
  let refill: (() => void) | null = null
  let closeList: (() => void) | null = null

  const count = h('span')
  const button = h('button', { class: 'tool', title: t('notesButtonTip'), onclick: () => openList() }, icon('note'), count)
  // A press would drop the selection the button is for.
  const addButton = h(
    'button',
    { class: 'tool note-add', title: t('noteAdd'), 'aria-label': t('noteAdd'), onmousedown: (event: MouseEvent) => event.preventDefault(), onclick: () => add() },
    icon('note')
  )
  const sendCount = h('span')
  const sendButton = h('button', { class: 'tool', title: t('notesSend', { count: 0 }), 'aria-label': t('notesSend', { count: 0 }), onclick: () => void openSend() }, icon('send'), sendCount)
  const syncCount = () => {
    count.textContent = `${t('notesButton')} (${notes.length})`
    const open = unsent(notes).length
    sendCount.textContent = String(open)
    sendButton.title = sendButton.ariaLabel = t('notesSend', { count: open })
    sendButton.style.display = open ? '' : 'none'
  }
  syncCount()
  const blobOf = (side: NoteSide) => (side === 'old' ? diff?.oldBlob : diff?.newBlob)

  function refresh(): void {
    syncCount()
    refill?.()
    const typing = editor && document.activeElement === editor.area ? editor.area : null
    options.rerender()
    typing?.focus({ preventScroll: true })
  }

  function put(note: ReviewNote): void {
    notes = notes.some((n) => n.id === note.id) ? notes.map((n) => (n.id === note.id ? note : n)) : [...notes, note]
    refresh()
  }

  async function remove(ids: string[], error: HTMLElement): Promise<void> {
    try {
      if (!(await api.notesDelete(root, ids)).ok) return
      notes = notes.filter((n) => !ids.includes(n.id))
      if (editor?.id && ids.includes(editor.id)) editor = null
      refresh()
    } catch (caught) {
      error.textContent = errorMessage(caught)
    }
  }

  /** The note the selection would make; null when it holds nothing of the side it started on. */
  function selected(): Anchor | null {
    const selection = getSelection()
    const side = container?.dataset.pick
    if (!container?.isConnected || !diff || !file || (side !== 'old' && side !== 'new') || !selection?.rangeCount || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    const blob = blobOf(side)
    const rev = side === 'new' ? file.to : file.from
    if (!container.contains(range.commonAncestorContainer) || !blob || !rev) return null
    const from = pointOf(container, range.startContainer, range.startOffset, side, true)
    const to = pointOf(container, range.endContainer, range.endOffset, side, false)
    // Both ends moved past each other onto the side's lines: none of them is selected.
    if (!from || !to || (from.line - to.line || from.col - to.col) > 0) return null
    const fit = anchor(sideLines(diff.hunks, side), from, to)
    if (!fit) return null
    const path = side === 'new' ? file.path : (file.oldPath ?? file.path)
    return { path, side, blob, rev, start: fit.start, end: fit.end, quote: fit.quote.slice(0, MAX_QUOTE) }
  }

  function add(): boolean {
    const at = selected()
    if (!at) return false
    addButton.remove()
    openEditor(at)
    return true
  }

  function openEditor(at: Anchor, id?: string, text = ''): void {
    const area = h('textarea', {
      class: 'field d-note-input',
      rows: 3,
      maxLength: MAX_BODY,
      placeholder: t('notePlaceholder'),
      onkeydown: (event: KeyboardEvent) => {
        if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
        // The tab's own keys stay out of the editor.
        event.stopPropagation()
        if (event.key === 'Enter' && event.shiftKey) return
        event.preventDefault()
        if (event.key === 'Escape') closeEditor()
        else void save()
      }
    })
    area.value = text
    const error = h('div', { class: 'd-note-error' })
    editor = { anchor: at, id, el: h('div', { class: 'd-note-edit' }, area, error), area, error }
    options.rerender()
    area.focus()
  }

  function closeEditor(): void {
    editor = null
    options.rerender()
  }

  async function save(): Promise<void> {
    const open = editor
    if (!open || saving || !open.area.value.trim()) return
    saving = true
    open.error.textContent = ''
    try {
      const body = open.area.value
      const result = open.id ? await api.noteUpdate(root, open.id, body) : await api.noteAdd(root, { ...open.anchor, body })
      if (!result.ok) open.error.textContent = result.reason
      else {
        if (editor === open) editor = null
        put(result.note)
      }
    } catch (caught) {
      open.error.textContent = errorMessage(caught)
    } finally {
      saving = false
    }
  }

  function card(n: ReviewNote): HTMLElement {
    const error = h('div', { class: 'd-note-error' })
    const tool = (name: keyof typeof ICONS, key: MessageKey, run: () => void) =>
      h('button', { class: 'tool', title: t(key), 'aria-label': t(key), onclick: run }, icon(name))
    // Sending again is an update with the same text: it clears the sent mark, so the note goes with the next sending.
    const resend = async () => {
      try {
        const result = await api.noteUpdate(root, n.id, n.body)
        if (result.ok) put(result.note)
        else error.textContent = result.reason
      } catch (caught) {
        error.textContent = errorMessage(caught)
      }
    }
    return h(
      'div',
      { class: 'd-note', dataset: { id: n.id } },
      h(
        'div',
        { class: 'd-note-head' },
        ...labels(n),
        h('span', { class: 'spacer' }),
        n.sentAt !== undefined && !n.reply ? tool('refresh', 'noteResend', () => void resend()) : null,
        tool('edit', 'noteEdit', () => openEditor(n, n.id, n.body)),
        tool('drop', 'noteDelete', () => void remove([n.id], error))
      ),
      h('div', { class: 'md' }, mdDom(n.body, openLink)),
      n.reply ? h('div', { class: 'd-note-reply' }, h('div', { class: 'd-note-caption' }, t('noteReply')), h('div', { class: 'md' }, mdDom(n.reply.body, openLink))) : null,
      error
    )
  }

  /** A row of the rows' grid with `child` in the code column of `side`. */
  function row(side: NoteSide, mode: DiffMode, child: HTMLElement): HTMLElement {
    const at = mode === 'unified' ? 2 : side === 'old' ? 1 : 3
    return h('div', { class: 'd-row d-notes' }, ...Array.from({ length: mode === 'unified' ? 3 : 4 }, (_, i) => h('div', null, i === at ? child : null)))
  }

  function openList(): void {
    const box = h('div', { class: 'notes-list' })
    refill = () => {
      const error = h('div', { class: 'd-note-error' })
      const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.start.line - b.start.line)
      let confirming = false
      const clearAll = (event: MouseEvent) => {
        if (confirming) return void remove(sorted.map((n) => n.id), error)
        confirming = true
        ;(event.currentTarget as HTMLElement).textContent = t('notesClearConfirm', { count: sorted.length })
      }
      box.replaceChildren(
        ...(sorted.length
          ? [
              h(
                'div',
                { class: 'notes-head' },
                h('button', { class: 'tool', onclick: () => void copyText(notesText(sorted)) }, icon('copy'), t('notesCopyAll')),
                h('button', { class: 'tool', onclick: clearAll }, t('notesClearAll'))
              ),
              ...sorted.map((n) => item(n, error))
            ]
          : [h('div', { class: 'notes-empty muted' }, t('notesEmpty'))]),
        error
      )
    }
    refill()
    closeList = showPopover(button, box, () => {
      refill = null
      closeList = null
    })
  }

  /** Whether the note `n` is of the file shown. */
  const ofFile = (n: ReviewNote) => file !== null && n.path === (n.side === 'new' ? file.path : (file.oldPath ?? file.path))

  /** The agent kinds Orca offers, plus claude and codex; the last one chosen first. */
  async function agents(): Promise<string[]> {
    let listed: string[] = []
    try {
      if (orca.host.has('agents.list')) {
        const answer = await orca.host.call('agents.list')
        listed = (Array.isArray(answer?.agents) ? answer.agents : []).map((a: { agent?: unknown }) => a?.agent).filter((a: unknown): a is string => typeof a === 'string' && a !== '')
      }
    } catch {
      listed = []
    }
    const all = [...new Set([...listed, 'claude', 'codex'])]
    return options.agent && all.includes(options.agent) ? [options.agent, ...all.filter((a) => a !== options.agent)] : all
  }

  let sending = false
  async function send(ids: string[], agent: string): Promise<void> {
    if (sending) return
    sending = true
    options.onAgent(agent)
    let reason: string | null = null
    try {
      const result = await api.notesSend(root, ids, agent)
      if (!result.ok) reason = result.reason
    } catch (caught) {
      reason = errorMessage(caught)
    } finally {
      sending = false
    }
    if (reason !== null) showPopover(sendButton, h('div', { class: 'd-note-error' }, reason))
  }

  async function openSend(): Promise<void> {
    const all = unsent(notes)
    if (!all.length) return
    const kinds = await agents()
    const here = all.filter(ofFile)
    const group = (label: string, list: ReviewNote[]): MenuEntry[] => [
      { label, disabled: true, run: () => undefined },
      ...kinds.map((agent): MenuEntry => ({ label: t('notesNewAgent', { agent }), run: () => void send(list.map((n) => n.id), agent) }))
    ]
    const rect = sendButton.getBoundingClientRect()
    showMenu(rect.left, rect.bottom + 4, [
      ...group(t('notesSendAll', { count: all.length }), all),
      ...(here.length && here.length < all.length ? ['separator' as const, ...group(t('notesSendFile', { count: here.length }), here)] : [])
    ], sendButton)
  }

  function item(n: ReviewNote, error: HTMLElement): HTMLElement {
    const index = files.findIndex((f) => (n.side === 'new' ? f.path : (f.oldPath ?? f.path)) === n.path)
    return h(
      'div',
      { class: 'notes-item' },
      // A note of a file this tab does not have stays in the list without a way to it.
      h(
        'button',
        { class: 'notes-open', disabled: index < 0, onclick: () => reveal(index, n.id) },
        h('span', { class: 'notes-where' }, h('span', { class: 'path' }, `${n.path}:${lineSpan(n)}`), label(n.side === 'old' ? 'noteSideOld' : 'noteSideNew'), ...labels(n)),
        h('span', { class: 'mono muted' }, firstLine(n.quote)),
        h('span', null, firstLine(n.body))
      ),
      h('button', { class: 'tool', title: t('noteDelete'), 'aria-label': t('noteDelete'), onclick: () => void remove([n.id], error) }, icon('drop'))
    )
  }

  /** Shows the file of a note and scrolls to its card; the whole file when its lines are not in the changed regions. */
  function reveal(index: number, id: string): void {
    closeList?.()
    const scroll = () => {
      const found = container?.isConnected ? Array.from(container.querySelectorAll<HTMLElement>('.d-note')).find((el) => el.dataset.id === id) : undefined
      found?.scrollIntoView({ block: 'center' })
      return found !== undefined
    }
    options.show(index, false, () => {
      if (!scroll()) options.show(index, true, scroll)
    })
  }

  const onUp = () => {
    if (!pressed) return
    pressed = false
    const range = selected() && getSelection()?.getRangeAt(0)
    if (!range) return
    const rects = range.getClientRects()
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect()
    addButton.style.left = `${Math.max(4, Math.min(end.right + 4, innerWidth - 30))}px`
    addButton.style.top = `${Math.max(4, Math.min(end.top + end.height / 2 - 13, innerHeight - 30))}px`
    document.body.append(addButton)
  }
  // While the press is held the selection collapses first and then grows: only a collapse after it ends the pick.
  const onSelection = () => {
    if (pressed || getSelection()?.isCollapsed === false) return
    if (container) delete container.dataset.pick
    addButton.remove()
  }
  const onScroll = () => addButton.remove()
  document.addEventListener('mouseup', onUp)
  document.addEventListener('selectionchange', onSelection)
  document.addEventListener('scroll', onScroll, true)

  return {
    buttons: [button, sendButton],
    rowsAfter(side, line, mode) {
      const rows = shown.filter((n) => n.side === side && n.end.line === line).map((n) => row(side, mode, editor?.id === n.id ? editor.el : card(n)))
      const open = editor
      if (open && !open.id && open.anchor.side === side && open.anchor.end.line === line && open.anchor.blob === blobOf(side)) rows.push(row(side, mode, open.el))
      return rows
    },
    mark(html, side, line, length) {
      for (const n of shown) {
        const range = coveredRange(n, side, line, length)
        if (range) html = markRange(html, range[0], range[1], 'note-mark')
      }
      return html
    },
    attach(lines, next, nextFile, mode) {
      container = lines
      diff = next
      file = nextFile
      shown = notesOf(notes, next).sort((a, b) => a.createdAt - b.createdAt)
      // The side a selection starts on: CSS keeps the other side and the cards out of it.
      lines.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return
        pressed = true
        addButton.remove()
        const cell = (event.target as Element).closest<HTMLElement>('.d-code')
        const kind = cell?.classList.contains('del') ? '-' : cell?.classList.contains('add') ? '+' : ' '
        if (cell) lines.dataset.pick = pickSide(mode, cell.parentElement?.children[1] === cell ? 'left' : 'right', kind)
        else delete lines.dataset.pick
      })
    },
    setNotes(list) {
      notes = list
      refresh()
    },
    addFromSelection: add,
    dispose() {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('scroll', onScroll, true)
      addButton.remove()
      closeList?.()
    }
  }
}
