// Review notes in the Diff tab: the selection and its button, the editor, the threads under their lines and the list of all notes.
import type { FileDiff, NoteDraft, NoteImage, NoteMessage, NotePlace, NotePoint, NoteResult, NoteSide, NoteVerdict, ReviewNote, SelectionFile } from '../shared/protocol.ts'
import { t, type MessageKey } from '../shared/i18n.ts'
import { carriedNotes, lastAnswer, MAX_BODY, MAX_IMAGES, MAX_QUOTE, MAX_REVIEW_SKILLS, noteBlob, noteFileIndex, notesOfFile, placeCandidate, placeTarget, stateOf, unsentOf } from '../shared/notes.ts'
import { api, copyText, errorMessage, orca } from './api.ts'
import type { DiffMode } from './diff.ts'
import { h, icon, ICONS } from './dom.ts'
import { fullDate, relativeDate, shortHash } from './format.ts'
import { markRange } from './highlight.ts'
import { disposeImages, thumbnail, uploadImage } from './images.ts'
import { mdDom } from './markdown.ts'
import { showMenu, showPopover, type MenuEntry } from './menu.ts'
import { active, anchor, authorOf, coveredRange, notesText, pickSide, sideLines, unsent } from './notemodel.ts'
import { browseDir, skillSuggestions } from './skillmodel.ts'

export interface NotesView {
  /** The header buttons: Notes (N) with the threads not resolved, and Send to an agent (N) while a thread is unsent. */
  buttons: HTMLElement[]
  /** The rows that follow the row of `line` on `side`: the cards of the notes that end there, and the editor when it is open there. */
  rowsAfter(side: NoteSide, line: number, mode: DiffMode): HTMLElement[]
  /** The cell's HTML with the notes' ranges wrapped in <span class="note-mark">. */
  mark(html: string, side: NoteSide, line: number, length: number): string
  /** Each render, before its rows are built: the container of the rows and what it shows. */
  attach(lines: HTMLElement, diff: FileDiff, file: SelectionFile, mode: DiffMode): void
  /** Loads the notes of the repository, and with them the answers the worker reads; a failure or a warning shows in the Notes list. */
  load(): Promise<void>
  /** Shows the file of this tab the note `id` shows in and scrolls to its card, as a click on it in the list does; call it once the file is shown. Before a list of notes is applied it waits for one. */
  reveal(id: string): void
  /** Ctrl+Shift+A: opens the editor on the current selection; false when there is none to note. */
  addFromSelection(): boolean
  /** When the open editor holds what the user typed or attached: shows it (its file first) with `reason` under it, and true. */
  hold(reason: string): boolean
  /** The notes of the diff shown, oldest first. */
  visible(): ReviewNote[]
  dispose(): void
}

/** Where a note goes: everything of a draft but its text and images. */
type Anchor = Omit<NoteDraft, 'body' | 'images'>
/** `file`: the index of the file it was opened in, which a thread carried there is not tied to by its blob. */
type Editor = { anchor: Anchor; id?: string; message?: string; start: string; images: NoteImage[]; sending: string[]; el: HTMLElement; area: HTMLTextAreaElement; error: HTMLElement; file: number }

/** Whether the editor holds text or images the user put there: another editor must not drop them. */
const typed = (e: Editor) => e.area.value.trim() !== e.start || (e.message === undefined && e.images.length > 0) || e.sending.length > 0

const VERDICT: Record<NoteVerdict, MessageKey> = { answered: 'noteAnswered', confirmed: 'noteConfirmed', refuted: 'noteRefuted', unclear: 'noteUnclear' }

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
const tool = (name: keyof typeof ICONS, key: MessageKey, run: () => void) => h('button', { class: 'tool', title: t(key), 'aria-label': t(key), onclick: run }, icon(name))
/** A thread's action that says what it does: an outlined button with its icon and its label. */
const action = (name: keyof typeof ICONS, key: MessageKey, run: () => void) => h('button', { class: 'tool d-note-action', onclick: run }, icon(name), h('span', null, t(key)))

/**
 * Delete, asked once more in place as Delete all is: the first press arms the button (the destructive look; its label and,
 * with `text`, its text say Press again to delete), the second runs `run`. Leaving the button, Esc or a redraw disarms it.
 */
function dropTool(key: MessageKey, run: () => void, text = true): HTMLElement {
  const words = h('span', null, t('noteDeleteConfirm'))
  const armed = () => button.classList.contains('armed')
  const arm = (on: boolean) => {
    button.classList.toggle('armed', on)
    button.title = button.ariaLabel = t(on ? 'noteDeleteConfirm' : key)
    // Before the icon: the icon stays where the first press found it.
    if (text && on) button.prepend(words)
    else words.remove()
  }
  const button = tool('drop', key, () => {
    if (!armed()) return arm(true)
    arm(false)
    run()
  })
  button.onblur = () => arm(false)
  button.onkeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !armed()) return
    event.preventDefault()
    event.stopPropagation()
    arm(false)
  }
  return button
}

/** The verdict of an agent's message and Fixed. */
const verdict = (m: NoteMessage): HTMLElement[] => (m.verdict ? [label(VERDICT[m.verdict], m.verdict), ...(m.fixed ? [label('noteFixed', 'fixed')] : [])] : [])

/** The state of a thread: resolved, sent and not answered, not sent, or the verdict of the agent's last answer. */
function labels(n: ReviewNote): HTMLElement[] {
  const state = stateOf(n)
  const answer = lastAnswer(n)
  if (state === 'answered' && answer) return verdict(answer)
  return state === 'resolved' ? [label('noteResolve', 'resolved')] : state === 'unsent' ? [label('noteUnsent')] : state === 'waiting' ? [label('noteSent')] : []
}

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

/**
 * A path field that suggests the files and folders `browse` lists in the folder typed so far: ↑ / ↓ pick, Enter or Tab
 * take a suggestion (a folder opens in the field, a file goes to `take`), Done or Enter with none take the typed path,
 * or go to `cancel` when nothing is typed (there is no path to take); Esc goes to `cancel`. Only the answer to the latest lookup is shown: none while the one for what was just typed is on
 * its way. Its parts are placed by the caller.
 */
function pathField(options: {
  /** The id of the suggestion list. */
  id: string
  label: string
  browse(dir: string): Promise<{ dirs: string[]; files: string[] }>
  take(path: string): void
  /** Each change of the text, before its lookup. */
  typed(): void
  cancel?(): void
}): { input: HTMLInputElement; list: HTMLElement; done: HTMLButtonElement; start(): void; stop(): void } {
  /** The suggestions shown, the highlighted one, and the count of lookups: only the answer to the latest one is shown. */
  let items: string[] = []
  let index = 0
  let lookups = 0
  const list = h('div', { class: 'notes-suggest', id: options.id, role: 'listbox', 'aria-label': options.label })
  const input = h('input', {
    class: 'field',
    type: 'text',
    autocomplete: 'off',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': options.id,
    placeholder: options.label,
    'aria-label': options.label,
    oninput: () => {
      options.typed()
      lookUp()
    },
    onkeydown: onKey
  })
  /** The typed path; an empty field closes, as a press of Done with nothing chosen means. */
  const takeTyped = () => (input.value.trim() ? options.take(input.value) : options.cancel?.())
  const done = h('button', { class: 'btn', onclick: takeTyped }, t('skillDone'))

  function showItems(keepInView = false): void {
    list.replaceChildren(
      ...items.map((path, i) =>
        h(
          'div',
          {
            class: `notes-suggest-item${i === index ? ' on' : ''}`,
            role: 'option',
            'aria-selected': String(i === index),
            // A press keeps the focus in the field.
            onmousedown: (event: MouseEvent) => event.preventDefault(),
            onclick: () => pick(path)
          },
          path
        )
      )
    )
    input.setAttribute('aria-expanded', String(items.length > 0))
    if (keepInView) list.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }

  /** No suggestions until the listing for what the field holds now comes: Enter meanwhile takes the typed path. */
  function lookUp(): void {
    items = []
    showItems()
    void suggest()
  }

  async function suggest(): Promise<void> {
    const mine = ++lookups
    const value = input.value
    let found: string[] = []
    try {
      found = skillSuggestions(value, await options.browse(browseDir(value)))
    } catch {
      found = []
    }
    if (mine !== lookups) return
    items = found
    index = 0
    showItems()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      index = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
      showItems(true)
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && items.length)) {
      if (items.length) pick(items[index])
      else takeTyped()
    } else if (event.key === 'Escape' && options.cancel) {
      event.stopPropagation()
      options.cancel()
    } else return
    event.preventDefault()
  }

  /** A picked folder opens in the field; a picked file is taken. */
  function pick(path: string): void {
    if (!path.endsWith('/')) return options.take(path)
    input.value = path
    input.focus()
    lookUp()
  }

  return {
    input,
    list,
    done,
    /** Empties the field, focuses it and lists the folder of the repository. */
    start() {
      input.value = ''
      input.focus()
      lookUp()
    },
    /** Drops the answer of a lookup still on its way: the field is closed. */
    stop() {
      lookups++
    }
  }
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
  /** Called when the open editor closes: saved, cancelled, or its thread gone. */
  closed(): void
}): NotesView {
  const { root, files } = options
  let notes: ReviewNote[] = []
  /** The notes of the diff shown, oldest first. */
  let shown: ReviewNote[] = []
  let container: HTMLElement | null = null
  let diff: FileDiff | null = null
  let file: SelectionFile | null = null
  /** Where the notes of other versions of `placed` stand on it (`notes.place`), and the count of requests: only the latest one's answer is taken. */
  let placed: SelectionFile | null = null
  let places: NotePlace[] = []
  let placing = 0
  /** The last places taken per file of the tab: a note's place on a version never changes, so a file shown again has its carried cards at once. */
  const known = new Map<SelectionFile, NotePlace[]>()
  /**
   * The open editor: a new note at `anchor`, a reply to the thread `id`, or the message `message` of the thread `id`, and
   * the text it started with; its images, and the names of those still being sent. Its element lives on across renders,
   * and the text and the images with it.
   */
  let editor: Editor | null = null
  /** The resolved threads opened from their one line. */
  const unfolded = new Set<string>()
  let saving = false
  /** A press in the rows is held: the selection is still being made. */
  let pressed = false
  let refill: (() => void) | null = null
  let closeList: (() => void) | null = null
  /** What the Notes list has to say: why the notes could not be loaded or the answers saved (until a load without it), and why a change was refused (until the list that shows it closes). */
  let warning = ''
  let refused = ''
  let loads = 0
  /** A list has been applied; until then a reveal waits in `pending`, as a load overtaken by a newer one applies none. */
  let applied = false
  let pending: string | null = null
  /** The agent chosen last, first in the menu. */
  let lastAgent = options.agent

  const count = h('span', { class: 'review-count' })
  const button = h('button', { class: 'tool review-btn', title: t('notesButtonTip'), onclick: () => void openList() }, icon('note'), h('span', null, t('notesButton')), count)
  // A press would drop the selection the button is for.
  const addButton = h(
    'button',
    { class: 'tool note-add', title: t('noteAdd'), 'aria-label': t('noteAdd'), onmousedown: (event: MouseEvent) => event.preventDefault(), onclick: () => add() },
    icon('note'),
    h('span', null, t('noteAddShort'))
  )
  const sendCount = h('span', { class: 'review-count' })
  const sendButton = h(
    'button',
    { class: 'tool review-btn primary', title: t('notesSend', { count: 0 }), 'aria-label': t('notesSend', { count: 0 }), onclick: () => void openSend() },
    icon('send'),
    h('span', null, t('notesSendButton')),
    sendCount
  )
  const notices = () => [refused, warning].filter(Boolean)
  const syncCount = () => {
    const unresolved = active(notes).length
    count.textContent = String(unresolved)
    // The label and the count read as one name, as the button's text said before it had a count of its own.
    button.ariaLabel = `${t('notesButton')} (${unresolved})`
    const said = notices()
    button.classList.toggle('notes-warn', said.length > 0)
    button.title = said.length ? said.join('\n') : t('notesButtonTip')
    const open = unsent(notes).length
    sendCount.textContent = String(open)
    sendButton.title = sendButton.ariaLabel = t('notesSend', { count: open })
    sendButton.style.display = open ? '' : 'none'
  }
  syncCount()
  // The rule of the panel's Files section: the file's blobs (those of the diff for M, A, D and R), none on a type change.
  const blobOf = (side: NoteSide) => (file ? noteBlob(file, side) : undefined)

  function refresh(): void {
    syncCount()
    refill?.()
    // The redraw moves the editor's element: the control of it that had the focus (the text, the path field, a thumbnail) gets it back.
    const focused = document.activeElement
    const kept = editor && focused instanceof HTMLElement && editor.el.contains(focused) ? focused : null
    options.rerender()
    kept?.focus({ preventScroll: true })
  }

  function put(note: ReviewNote): void {
    notes = notes.some((n) => n.id === note.id) ? notes.map((n) => (n.id === note.id ? note : n)) : [...notes, note]
    refresh()
  }

  /** Shows why a change was refused: on the Notes button, and in the list. */
  function notify(text: string): void {
    refused = text
    syncCount()
    refill?.()
  }

  async function load(): Promise<void> {
    const mine = ++loads
    let list: ReviewNote[] | null = null
    let said = ''
    try {
      const answer = await api.notes(root)
      list = answer.notes
      said = answer.warning ?? ''
    } catch (caught) {
      said = t('notesLoadFailed', { error: errorMessage(caught) })
    }
    // Only the latest answer is shown, and none after dispose.
    if (mine !== loads) return
    if (list) {
      notes = list
      applied = true
      // A new list may have notes of other versions of the file shown; the places shown so far stay until the answer.
      if (file) place(file)
    }
    warning = said
    refresh()
    if (applied && pending) {
      const id = pending
      pending = null
      revealNote(id)
    }
  }

  /**
   * Shows the file of this tab the note `id` shows in and scrolls to its card; before the first list, once it is applied; a note
   * that may be carried to the file shown (a row of the panel's Files), once its places there come, or `unplaced`: they did not.
   */
  function revealNote(id: string, unplaced = false): void {
    const note = notes.find((n) => n.id === id)
    pending = !applied || (!unplaced && note && file && !known.has(file) && placeTarget(note, file) !== undefined) ? id : null
    if (pending) return
    const index = note ? shownIn(note) : -1
    if (index >= 0) reveal(index, id)
  }

  /** Drops the threads `ids` the worker no longer has, and the editor open in one of them. */
  function forget(ids: string[]): void {
    notes = notes.filter((n) => !ids.includes(n.id))
    if (editor?.id && ids.includes(editor.id)) drop()
    refresh()
  }

  /** Deletes the notes `ids`; with `all`, every note of the repository, those a cut list did not show too. */
  async function remove(ids: string[], all = false): Promise<void> {
    try {
      const result = all ? await api.notesDeleteAll(root) : await api.notesDelete(root, ids)
      if (!result.ok) return notify(result.reason ?? '')
      forget(ids)
    } catch (caught) {
      notify(errorMessage(caught))
    }
  }

  /** Shows the thread `id` as a change of it left it: changed, or gone with its last message. */
  async function change(id: string, request: Promise<NoteResult>): Promise<void> {
    try {
      const result = await request
      if (!result.ok) notify(result.reason)
      else if (result.note) put(result.note)
      else forget([id])
    } catch (caught) {
      notify(errorMessage(caught))
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

  /**
   * Opens the editor of a new note at `at`, of a reply to the thread `of.id`, or of its message `of.message` with its
   * `images`. A new note and a reply take images pasted or picked by path; an edit keeps the message's images as they are.
   */
  function openEditor(at: Anchor, of?: { id: string; message?: string }, text = '', images: NoteImage[] = []): void {
    const open = editor
    // What the user typed or attached is not dropped for another editor: the open one is shown instead. One out of view (another file) cannot be.
    if (open && typed(open) && open.el.isConnected) {
      open.el.scrollIntoView({ block: 'nearest' })
      open.area.focus({ preventScroll: true })
      return
    }
    const editing = of?.message !== undefined
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
      },
      onpaste: editing ? undefined : (event: ClipboardEvent) => void paste(event)
    })
    area.value = text
    const error = h('div', { class: 'd-note-error' })
    const strip = h('div', { class: 'd-note-images' })
    const mine: Editor = { anchor: at, id: of?.id, message: of?.message, start: text, images, sending: [], el: h('div', { class: 'd-note-edit' }, area, strip, error), area, error, file: file ? files.indexOf(file) : -1 }
    const attachButton = tool('image', 'imageAttach', () => {
      if (field.parentNode) return picker.input.focus()
      error.before(field)
      picker.start()
    })
    const picker = pathField({
      id: 'd-image-suggest',
      label: t('imagePath'),
      browse: (dir) => api.imagesBrowse(root, dir),
      take: (path) => void attach(path.slice(path.lastIndexOf('/') + 1), () => api.imagesAttach(root, path)).then((ok) => ok && closeField()),
      typed: () => (error.textContent = ''),
      cancel: () => closeField()
    })
    const field = h('div', { class: 'notes-skill-field d-note-attach' }, picker.input, picker.list, picker.done)
    // What the field said goes with it: it was about the path, which is gone.
    const closeField = () => {
      picker.stop()
      field.remove()
      error.textContent = ''
      area.focus()
    }
    /** The images, each with Remove unless the message is edited, then the ones being sent and Attach a file. */
    const draw = () =>
      strip.replaceChildren(
        ...mine.images.map((image) =>
          h(
            'span',
            { class: 'd-image-item' },
            thumbnail(root, image),
            editing
              ? null
              : h(
                  'button',
                  {
                    class: 'tool',
                    title: t('imageRemove', { name: image.name }),
                    'aria-label': t('imageRemove', { name: image.name }),
                    onclick: () => {
                      // The save running has taken the images already.
                      if (saving) return
                      mine.images = mine.images.filter((i) => i !== image)
                      draw()
                      area.focus()
                    }
                  },
                  icon('close')
                )
          )
        ),
        ...mine.sending.map((name) => h('span', { class: 'd-image' }, name)),
        ...(editing ? [] : [attachButton])
      )
    /**
     * Attaches the image `get` stores while the message has room for one more; a refusal shows under the field. Nothing is
     * attached while the message is being saved: the save has taken its images already. True when attached.
     */
    const attach = async (name: string, get: () => Promise<{ ok: true; image: NoteImage } | { ok: false; reason: string }>): Promise<boolean> => {
      if (saving) return false
      if (mine.images.length + mine.sending.length >= MAX_IMAGES) {
        error.textContent = t('imageMany')
        return false
      }
      error.textContent = ''
      mine.sending.push(name)
      draw()
      const result = await get().catch((caught: unknown) => ({ ok: false as const, reason: errorMessage(caught) }))
      mine.sending.splice(mine.sending.indexOf(name), 1)
      if (!result.ok) error.textContent = result.reason
      else if (!mine.images.some((i) => i.id === result.image.id)) mine.images = [...mine.images, result.image]
      draw()
      return result.ok
    }
    /** Pasted image files are sent one after another, until one is refused; plain text pasted with them or alone goes in as text. */
    const paste = async (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      const items = Array.from(event.clipboardData?.items ?? []).filter((item) => item.kind === 'file').map((item) => item.getAsFile())
      const pasted = (files.length ? files : items).filter((file): file is File => file?.type.startsWith('image/') === true)
      if (!pasted.length) return
      if (!event.clipboardData?.getData('text/plain')) event.preventDefault()
      for (const file of pasted) if (!(await attach(file.name, () => uploadImage(root, file, file.name)))) break
    }
    draw()
    editor = mine
    options.rerender()
    area.focus()
  }

  /** Forgets the open editor: an opening of the tab may wait for it. */
  function drop(): void {
    editor = null
    options.closed()
  }

  function closeEditor(): void {
    drop()
    options.rerender()
  }

  /** Brings the open editor into view and focus; one in another file of the tab, that file first (with Whole file when its lines need it). */
  function showEditor(open: Editor): void {
    const focus = () => {
      if (!open.el.isConnected) return false
      open.el.scrollIntoView({ block: 'nearest' })
      open.area.focus({ preventScroll: true })
      return true
    }
    if (focus()) return
    if (open.file >= 0) options.show(open.file, false, () => void (focus() || options.show(open.file, true, focus)))
  }

  async function save(): Promise<void> {
    const open = editor
    // An image still being sent would be left out: the save waits for the user to press again.
    if (!open || saving || open.sending.length) return
    if (!open.area.value.trim()) {
      // Images alone make no message: say what is missing.
      if (open.images.length) open.error.textContent = t('noteNeedsText')
      return
    }
    // An edit that changes nothing sends nothing.
    if (open.message && open.area.value.trim() === open.start) return closeEditor()
    saving = true
    open.error.textContent = ''
    try {
      const body = open.area.value
      const images = open.images.length ? open.images : undefined
      const result = !open.id
        ? await api.noteAdd(root, { ...open.anchor, body, ...(images ? { images } : {}) })
        : open.message
          ? await api.noteEdit(root, open.id, open.message, body)
          : await api.noteReply(root, open.id, body, images)
      if (!result.ok) open.error.textContent = result.reason
      else if (result.note) {
        if (editor === open) drop()
        put(result.note)
      }
    } catch (caught) {
      open.error.textContent = errorMessage(caught)
    } finally {
      saving = false
    }
  }

  /** A message: its author and time, an agent's verdict, Not sent on the user's own until it goes out and Edit until then, Delete. */
  function message(n: ReviewNote, m: NoteMessage): HTMLElement {
    const draft = unsentOf(n).includes(m)
    return h(
      'div',
      { class: `d-note-msg ${m.author}`, dataset: { id: m.id } },
      h(
        'div',
        { class: 'd-note-msg-head' },
        h('span', { class: 'd-note-author' }, authorOf(m)),
        h('span', { class: 'muted', title: fullDate(m.at / 1000) }, relativeDate(m.at / 1000)),
        ...verdict(m),
        draft ? h('span', { class: 'muted d-note-unsent' }, t('noteUnsent')) : null,
        h('span', { class: 'spacer' }),
        draft ? tool('edit', 'noteEdit', () => openEditor(n, { id: n.id, message: m.id }, m.body, m.images)) : null,
        dropTool('noteDeleteMessage', () => void change(n.id, api.noteRemove(root, n.id, m.id)))
      ),
      h('div', { class: 'md' }, mdDom(m.body, openLink)),
      m.images?.length ? h('div', { class: 'd-note-images' }, ...m.images.map((image) => thumbnail(root, image))) : null
    )
  }

  /** After a redraw took the focused control away, focuses the control `selector` of the thread `id` in its place. */
  function refocus(id: string, selector: string): void {
    if (document.activeElement && document.activeElement !== document.body) return
    const found = container?.isConnected ? Array.from(container.querySelectorAll<HTMLElement>('.d-note')).find((el) => el.dataset.id === id) : undefined
    found?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
  }

  /** A thread: its state and buttons, its messages, and Reply… under them; a resolved one is one line until it is opened. */
  function card(n: ReviewNote): HTMLElement {
    const resolved = n.resolvedAt !== undefined
    const mine = editor?.id === n.id ? editor : null
    // The editor open in a thread keeps it open.
    const open = !resolved || unfolded.has(n.id) || mine !== null
    const fold = () => {
      // The editor open in the thread keeps it open: a press changes nothing.
      if (mine) return
      if (!unfolded.delete(n.id)) unfolded.add(n.id)
      options.rerender()
      refocus(n.id, '.d-note-fold')
    }
    const resolve = (yes: boolean) => {
      unfolded.delete(n.id)
      void change(n.id, api.noteResolve(root, n.id, yes)).then(() => refocus(n.id, '.d-note-toggle'))
    }
    const toggle = resolved ? action('undo', 'noteReopen', () => resolve(false)) : action('check', 'noteResolve', () => resolve(true))
    toggle.classList.add('d-note-toggle')
    return h(
      'div',
      { class: `d-note${resolved ? ' resolved' : ''}`, dataset: { id: n.id } },
      h(
        'div',
        { class: 'd-note-head' },
        ...(resolved
          ? [
              h(
                'button',
                { class: 'd-note-fold', 'aria-expanded': String(open), onclick: fold },
                ...labels(n),
                h('span', { class: 'd-note-first' }, firstLine(n.messages[0]?.body ?? '')),
                h('span', { class: 'muted' }, t('noteMessages', { count: n.messages.length }))
              )
            ]
          : [...labels(n), h('span', { class: 'spacer' })]),
        // Sending again takes the sent mark off the messages nobody answered, so they go with the next sending.
        stateOf(n) === 'waiting' ? action('refresh', 'noteResend', () => void change(n.id, api.noteResend(root, n.id))) : null,
        toggle,
        dropTool('noteDeleteThread', () => void remove([n.id]))
      ),
      ...(open ? n.messages.map((m) => (mine?.message === m.id ? mine.el : message(n, m))) : []),
      // A reply being written stays in its thread, resolved meanwhile or not; a new one starts only in a thread not resolved.
      mine && !mine.message ? mine.el : resolved ? null : h('button', { class: 'd-note-reply', onclick: () => openEditor(n, { id: n.id }) }, t('noteReply'))
    )
  }

  /** A row of the rows' grid with `child` in the code column of `side`. */
  function row(side: NoteSide, mode: DiffMode, child: HTMLElement): HTMLElement {
    const at = mode === 'unified' ? 2 : side === 'old' ? 1 : 3
    return h('div', { class: 'd-row d-notes' }, ...Array.from({ length: mode === 'unified' ? 3 : 4 }, (_, i) => h('div', null, i === at ? child : null)))
  }

  /**
   * The review skills of the Notes list: each path with Remove, and Add a skill, which opens a path field with suggestions.
   * Skills that could not be loaded show why, and nothing to change: a save would replace the stored list. A refused
   * change shows here, under the field or the list: the notice line at the top of the list may be scrolled away.
   */
  function skillsSection(loaded: { skills: string[] } | { error: string }): HTMLElement {
    const el = h('div', { class: 'notes-skills' })
    const head = (count: number | null) =>
      h('div', { class: 'notes-skills-head' }, h('span', { class: 'notes-skills-title' }, t('skillsTitle')), count === null ? null : h('span', { class: 'count' }, String(count)))
    if ('error' in loaded) {
      el.append(head(null), h('div', { class: 'd-note-error' }, t('notesLoadFailed', { error: loaded.error })))
      return el
    }
    let skills = loaded.skills
    let adding = false
    /** The save running: the next one waits for it and starts from the list it stored. */
    let saving: Promise<unknown> = Promise.resolve()
    const fieldError = h('div', { class: 'd-note-error', role: 'alert' })
    const listError = h('div', { class: 'd-note-error', role: 'alert' })
    const addSkill = h('button', { class: 'btn', onclick: openField }, t('skillAdd'))
    const picker = pathField({
      id: 'notes-skill-suggest',
      label: t('skillPath'),
      browse: (dir) => api.skillsBrowse(root, dir),
      take: (path) => void add(path),
      typed: () => refuse(null),
      cancel: () => {
        adding = false
        picker.stop()
        refuse(null)
        draw()
        addSkill.focus()
      }
    })
    const field = h('div', { class: 'notes-skill-field' }, picker.input, fieldError, picker.list, picker.done)

    function draw(): void {
      el.replaceChildren(
        head(skills.length),
        h('div', { class: 'notes-skills-hint' }, t('skillsHint')),
        ...skills.map((path) =>
          h(
            'div',
            { class: 'notes-skill' },
            h('span', { class: 'mono' }, path),
            h('button', { class: 'tool', title: t('skillRemove', { path }), 'aria-label': t('skillRemove', { path }), onclick: () => void remove(path) }, icon('close'))
          )
        ),
        listError,
        ...(adding ? [field] : skills.length < MAX_REVIEW_SKILLS ? [addSkill] : [])
      )
    }

    /** Shows why a change was refused at `at` (the field's line or the list's), and clears the other; null clears both. */
    function refuse(at: HTMLElement | null, reason = ''): void {
      for (const line of [fieldError, listError]) line.textContent = line === at ? reason : ''
    }

    function openField(): void {
      adding = true
      draw()
      picker.start()
    }

    /**
     * Stores the list `change` makes of the stored one, once the save before it has answered (the worker answers the list
     * it stored); true when stored. A refusal shows at `at`.
     */
    function save(change: (stored: string[]) => string[], at: HTMLElement): Promise<boolean> {
      const run = saving.then(async () => {
        try {
          const result = await api.skillsSet(root, change(skills))
          if (!result.ok) {
            refuse(at, result.reason)
            return false
          }
          skills = result.skills
          refuse(null)
          return true
        } catch (caught) {
          refuse(at, errorMessage(caught))
          return false
        }
      })
      saving = run
      return run
    }

    async function add(path: string): Promise<void> {
      if (!(await save((stored) => [...stored, path], fieldError))) return
      adding = false
      picker.stop()
      draw()
      // At ten skills there is no Add button: the focus stays in the list, on the last row.
      ;(skills.length < MAX_REVIEW_SKILLS ? addSkill : Array.from(el.querySelectorAll<HTMLElement>('.notes-skill .tool')).pop())?.focus()
    }

    async function remove(path: string): Promise<void> {
      if (!(await save((stored) => stored.filter((s) => s !== path), listError))) return
      draw()
      ;(adding ? picker.input : addSkill).focus()
    }

    draw()
    return el
  }

  async function openList(): Promise<void> {
    // The worker reads the agent's answers with the list: opening it shows the fresh ones. The review skills come with them.
    const loading = load()
    const skills = api.skills(root).catch((caught) => ({ error: errorMessage(caught) }))
    await loading
    const section = skillsSection(await skills)
    const box = h('div', { class: 'notes-list' }, section)
    const fill = () => {
      // The resolved threads last.
      const sorted = [...notes].sort((a, b) => Number(a.resolvedAt !== undefined) - Number(b.resolvedAt !== undefined) || a.path.localeCompare(b.path) || a.start.line - b.start.line)
      const said = notices()
      let confirming = false
      // Every thread of the repository goes, those a cut list did not show too: the question names no count.
      const clearAll = (event: MouseEvent) => {
        if (confirming) return void remove(sorted.map((n) => n.id), true)
        confirming = true
        ;(event.currentTarget as HTMLElement).textContent = t('notesClearConfirm')
      }
      // The skills stay in place: a redraw of the notes keeps the open path field, its text and its focus.
      while (box.firstChild && box.firstChild !== section) box.firstChild.remove()
      section.before(
        ...(said.length ? [h('div', { class: 'warning notes-notice' }, icon('warning'), h('div', null, ...said.map((text) => h('div', null, text))))] : []),
        ...(sorted.length
          ? [
              h(
                'div',
                { class: 'notes-head' },
                h('button', { class: 'tool', onclick: () => void copyText(notesText(sorted)) }, icon('copy'), t('notesCopyAll')),
                h('button', { class: 'tool', onclick: clearAll }, t('notesClearAll'))
              ),
              ...sorted.map((n) => item(n))
            ]
          : [h('div', { class: 'notes-empty muted' }, t('notesEmpty'))])
      )
    }
    fill()
    closeList = showPopover(button, box, () => {
      refill = null
      closeList = null
      // A refusal the list has shown is done with.
      refused = ''
      syncCount()
    })
    refill = fill
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
    return lastAgent && all.includes(lastAgent) ? [lastAgent, ...all.filter((a) => a !== lastAgent)] : all
  }

  let sending = false
  async function send(ids: string[], agent?: string): Promise<void> {
    if (sending) return
    sending = true
    if (agent) {
      lastAgent = agent
      options.onAgent(agent)
    }
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
    // The earlier agent, when its terminal is open and it is free, takes the next messages: no kind to pick.
    const same = await api.notesAgent(root).then((r) => r.agent, () => null)
    const kinds = same ? [] : await agents()
    const here = all.filter(ofFile)
    const group = (label: string, list: ReviewNote[]): MenuEntry[] => same
      ? [{ label: t('notesSendSame', { scope: label, agent: same }), run: () => void send(list.map((n) => n.id)) }]
      : [
          { label, disabled: true, run: () => undefined },
          ...kinds.map((agent): MenuEntry => ({ label: t('notesNewAgent', { agent }), run: () => void send(list.map((n) => n.id), agent) }))
        ]
    const rect = sendButton.getBoundingClientRect()
    showMenu(rect.left, rect.bottom + 4, [
      ...group(t('notesSendAll', { count: all.length }), all),
      ...(here.length && here.length < all.length ? ['separator' as const, ...group(t('notesSendFile', { count: here.length }), here)] : [])
    ], sendButton)
  }

  /** The file of this tab the note shows in, the one shown first; -1: none. */
  const fileOf = (n: Pick<ReviewNote, 'side' | 'blob' | 'path'>) => noteFileIndex(files, n, file ? files.indexOf(file) : -1)

  /** Whether the note `id` of another version of the file shown was carried to it. */
  const carriedHere = (id: string) => places.some((p) => p.id === id && 'start' in p)
  /** The file of this tab a note shows in: the file shown when the note is carried to it, else `fileOf`. */
  const shownIn = (n: ReviewNote) => (file && carriedHere(n.id) ? files.indexOf(file) : fileOf(n))

  /**
   * Asks the worker where the notes of other versions of `of` stand on it, when a note may be one (`placeCandidate`); its answer
   * redraws unless the tab asked again since, for another file or a new list. Until it comes, the places last taken for the file
   * stay, and so they do when the request fails (the worker logs its own errors): an empty answer would take a carried card away,
   * with an editor open in it that the tab then keeps waiting for.
   */
  function place(of: SelectionFile): void {
    const mine = ++placing
    if (of !== placed) places = known.get(of) ?? []
    placed = of
    if (!placeCandidate(notes, of)) {
      places = []
      return
    }
    void api
      .notesPlace(root, [of])
      .then((answer) => answer.places[0] ?? [], () => null)
      .then((next) => {
        if (mine !== placing) return
        if (next) {
          known.set(of, next)
          // The same places again (a new list that moved none) redraw nothing: a redraw disarms a Delete pressed once.
          if (JSON.stringify(next) !== JSON.stringify(places)) {
            places = next
            refresh()
          }
        }
        // A reveal of a note that may be carried here waited for these places; without them, it goes where the note shows.
        if (pending) revealNote(pending, !next)
      })
  }

  function item(n: ReviewNote): HTMLElement {
    // A note carried to the file shown is there, at its lines in this version.
    const index = shownIn(n)
    return h(
      'div',
      { class: `notes-item${n.resolvedAt !== undefined ? ' resolved' : ''}` },
      h(
        'button',
        { class: 'notes-open', onclick: () => (index >= 0 ? reveal(index, n.id) : void openCommit(n.id)) },
        h(
          'span',
          { class: 'notes-where' },
          h('span', { class: 'path', title: `${n.path}:${lineSpan(n)}` }, `${n.path}:${lineSpan(n)}`),
          label(n.side === 'old' ? 'noteSideOld' : 'noteSideNew'),
          ...labels(n),
          n.outdated ? h('span', { class: 'd-label outdated', title: t('noteOutdatedTip', { rev: shortHash(n.rev) }) }, t('noteOutdated')) : null,
          h('span', { class: 'muted' }, t('noteMessages', { count: n.messages.length }))
        ),
        h('span', { class: 'mono muted' }, firstLine(n.quote)),
        h('span', null, firstLine(n.messages[0]?.body ?? ''))
      ),
      // The list is narrow: its rows say it by the look and the label only.
      dropTool('noteDeleteThread', () => void remove([n.id]), false)
    )
  }

  /** A note this tab does not show: the worker opens the commit whose own diff shows it, in this tab; a refusal shows at the top of the list. */
  async function openCommit(id: string): Promise<void> {
    closeList?.()
    try {
      const result = await api.notesOpen(root, id)
      if (!result.ok) notify(result.reason ?? '')
    } catch (caught) {
      notify(errorMessage(caught))
    }
  }

  /** Shows the file of a note and scrolls to its card; the whole file when the note is of the diff shown but its lines are not in the changed regions. */
  function reveal(index: number, id: string): void {
    closeList?.()
    const scroll = () => {
      const found = container?.isConnected ? Array.from(container.querySelectorAll<HTMLElement>('.d-note')).find((el) => el.dataset.id === id) : undefined
      found?.scrollIntoView({ block: 'center' })
      return found !== undefined
    }
    options.show(index, false, () => {
      const note = notes.find((n) => n.id === id)
      // A note of other content (the file has changed since) has no card in this diff, whole file or not, unless it was carried here.
      if (!scroll() && note && (note.blob === blobOf(note.side) || carriedHere(id))) options.show(index, true, scroll)
    })
  }

  const onUp = () => {
    if (!pressed) return
    pressed = false
    const range = selected() && getSelection()?.getRangeAt(0)
    if (!range) return
    const rects = range.getClientRects()
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect()
    // In first, so its width is known: the label makes it wider than its height.
    document.body.append(addButton)
    addButton.style.left = `${Math.max(4, Math.min(end.right + 4, innerWidth - addButton.offsetWidth - 4))}px`
    addButton.style.top = `${Math.max(4, Math.min(end.top + end.height / 2 - 13, innerHeight - 30))}px`
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
      const rows = shown.filter((n) => n.side === side && n.end.line === line).map((n) => row(side, mode, card(n)))
      const open = editor
      if (open && !open.id && open.anchor.side === side && open.anchor.end.line === line && open.anchor.blob === blobOf(side)) rows.push(row(side, mode, open.el))
      return rows
    },
    mark(html, side, line, length) {
      // The text a new note's open editor is about stays marked, as a note's is.
      const draft = editor && !editor.id && editor.anchor.blob === blobOf(side) ? [editor.anchor] : []
      for (const n of [...shown, ...draft]) {
        const range = coveredRange(n, side, line, length)
        if (range) html = markRange(html, range[0], range[1], 'note-mark')
      }
      return html
    },
    attach(lines, next, nextFile, mode) {
      container = lines
      diff = next
      file = nextFile
      if (nextFile !== placed) place(nextFile)
      shown = [...notesOfFile(notes, nextFile), ...carriedNotes(notes, places)].sort((a, b) => a.createdAt - b.createdAt)
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
    load,
    reveal: revealNote,
    addFromSelection: add,
    hold(reason) {
      const open = editor
      if (!open || !typed(open)) return false
      // A warning, not a failure: yellow, under the editor's own errors.
      open.el.querySelector('.d-note-wait')?.remove()
      open.el.append(h('div', { class: 'd-note-wait', role: 'status' }, reason))
      showEditor(open)
      return true
    },
    visible: () => shown,
    dispose() {
      loads++
      placing++
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('scroll', onScroll, true)
      addButton.remove()
      closeList?.()
      disposeImages()
    }
  }
}
