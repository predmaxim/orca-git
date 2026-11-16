// Review notes in the Diff tab: the selection and its button, the editor, the threads under their lines and the list of all notes.
import type { FileDiff, NoteDraft, NoteMessage, NotePoint, NoteResult, NoteSide, NoteVerdict, ReviewNote, SelectionFile } from '../shared/protocol.ts'
import { t, type MessageKey } from '../shared/i18n.ts'
import { lastAnswer, MAX_BODY, MAX_QUOTE, MAX_REVIEW_SKILLS, stateOf } from '../shared/notes.ts'
import { api, copyText, errorMessage, orca } from './api.ts'
import type { DiffMode } from './diff.ts'
import { h, icon, ICONS } from './dom.ts'
import { fullDate, relativeDate } from './format.ts'
import { markRange } from './highlight.ts'
import { mdDom } from './markdown.ts'
import { showMenu, showPopover, type MenuEntry } from './menu.ts'
import { active, anchor, authorOf, coveredRange, notesOf, notesText, pickSide, sideLines, unsent } from './notemodel.ts'
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
  /** Ctrl+Shift+A: opens the editor on the current selection; false when there is none to note. */
  addFromSelection(): boolean
  dispose(): void
}

/** Where a note goes: everything of a draft but its text. */
type Anchor = Omit<NoteDraft, 'body'>

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
  /**
   * The open editor: a new note at `anchor`, a reply to the thread `id`, or the message `message` of the thread `id`, and
   * the text it started with. Its element lives on across renders, and the text with it.
   */
  let editor: { anchor: Anchor; id?: string; message?: string; start: string; el: HTMLElement; area: HTMLTextAreaElement; error: HTMLElement } | null = null
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
  /** The agent chosen last, first in the menu. */
  let lastAgent = options.agent

  const count = h('span')
  const button = h('button', { class: 'tool', title: t('notesButtonTip'), onclick: () => void openList() }, icon('note'), count)
  // A press would drop the selection the button is for.
  const addButton = h(
    'button',
    { class: 'tool note-add', title: t('noteAdd'), 'aria-label': t('noteAdd'), onmousedown: (event: MouseEvent) => event.preventDefault(), onclick: () => add() },
    icon('note')
  )
  const sendCount = h('span')
  const sendButton = h('button', { class: 'tool', title: t('notesSend', { count: 0 }), 'aria-label': t('notesSend', { count: 0 }), onclick: () => void openSend() }, icon('send'), sendCount)
  const notices = () => [refused, warning].filter(Boolean)
  const syncCount = () => {
    count.textContent = `${t('notesButton')} (${active(notes).length})`
    const said = notices()
    button.classList.toggle('notes-warn', said.length > 0)
    button.title = said.length ? said.join('\n') : t('notesButtonTip')
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
    if (list) notes = list
    warning = said
    refresh()
  }

  /** Drops the threads `ids` the worker no longer has, and the editor open in one of them. */
  function forget(ids: string[]): void {
    notes = notes.filter((n) => !ids.includes(n.id))
    if (editor?.id && ids.includes(editor.id)) editor = null
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

  /** Opens the editor of a new note at `at`, of a reply to the thread `of.id`, or of its message `of.message`. */
  function openEditor(at: Anchor, of?: { id: string; message?: string }, text = ''): void {
    const open = editor
    // Typed text is not dropped for another editor: the open one is shown instead. One out of view (another file) cannot be.
    if (open && open.area.value.trim() !== open.start && open.el.isConnected) {
      open.el.scrollIntoView({ block: 'nearest' })
      open.area.focus({ preventScroll: true })
      return
    }
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
    editor = { anchor: at, id: of?.id, message: of?.message, start: text, el: h('div', { class: 'd-note-edit' }, area, error), area, error }
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
    // An edit that changes nothing sends nothing.
    if (open.message && open.area.value.trim() === open.start) return closeEditor()
    saving = true
    open.error.textContent = ''
    try {
      const body = open.area.value
      const result = !open.id
        ? await api.noteAdd(root, { ...open.anchor, body })
        : open.message
          ? await api.noteEdit(root, open.id, open.message, body)
          : await api.noteReply(root, open.id, body)
      if (!result.ok) open.error.textContent = result.reason
      else if (result.note) {
        if (editor === open) editor = null
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
    const draft = m.author === 'user' && m.sentAt === undefined
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
        draft ? tool('edit', 'noteEdit', () => openEditor(n, { id: n.id, message: m.id }, m.body)) : null,
        tool('drop', 'noteDeleteMessage', () => void change(n.id, api.noteRemove(root, n.id, m.id)))
      ),
      h('div', { class: 'md' }, mdDom(m.body, openLink))
    )
  }

  /** A thread: its state and buttons, its messages, and Reply… under them; a resolved one is one line until it is opened. */
  function card(n: ReviewNote): HTMLElement {
    const resolved = n.resolvedAt !== undefined
    const mine = editor?.id === n.id ? editor : null
    // The editor open in a thread keeps it open.
    const open = !resolved || unfolded.has(n.id) || mine !== null
    const fold = () => {
      if (!unfolded.delete(n.id)) unfolded.add(n.id)
      options.rerender()
    }
    const resolve = (yes: boolean) => {
      unfolded.delete(n.id)
      void change(n.id, api.noteResolve(root, n.id, yes))
    }
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
        stateOf(n) === 'waiting' ? tool('refresh', 'noteResend', () => void change(n.id, api.noteResend(root, n.id))) : null,
        resolved ? tool('undo', 'noteReopen', () => resolve(false)) : tool('check', 'noteResolve', () => resolve(true)),
        tool('drop', 'noteDeleteThread', () => void remove([n.id]))
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
    /** The suggestions shown, the highlighted one, and the count of lookups: only the answer to the latest one is shown. */
    let items: string[] = []
    let index = 0
    let lookups = 0
    /** The save running: the next one waits for it and starts from the list it stored. */
    let saving: Promise<unknown> = Promise.resolve()
    const fieldError = h('div', { class: 'd-note-error', role: 'alert' })
    const listError = h('div', { class: 'd-note-error', role: 'alert' })
    const addSkill = h('button', { class: 'btn', onclick: openField }, t('skillAdd'))
    const list = h('div', { class: 'notes-suggest', id: 'notes-skill-suggest', role: 'listbox', 'aria-label': t('skillPath') })
    const input = h('input', {
      class: 'field',
      type: 'text',
      autocomplete: 'off',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'notes-skill-suggest',
      placeholder: t('skillPath'),
      'aria-label': t('skillPath'),
      oninput: () => {
        refuse(null)
        lookUp()
      },
      onkeydown: onKey
    })
    const field = h('div', { class: 'notes-skill-field' }, input, fieldError, list, h('button', { class: 'btn', onclick: () => void add(input.value) }, t('skillDone')))

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
        found = skillSuggestions(value, await api.skillsBrowse(root, browseDir(value)))
      } catch {
        found = []
      }
      if (mine !== lookups || !adding) return
      items = found
      index = 0
      showItems()
    }

    function openField(): void {
      adding = true
      input.value = ''
      draw()
      input.focus()
      lookUp()
    }

    function onKey(event: KeyboardEvent): void {
      if (event.isComposing) return
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
        index = (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
        showItems(true)
      } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && items.length)) {
        if (items.length) pick(items[index])
        else void add(input.value)
      } else return
      event.preventDefault()
    }

    /** A picked folder opens in the field; a picked file is added. */
    function pick(path: string): void {
      if (!path.endsWith('/')) return void add(path)
      input.value = path
      input.focus()
      lookUp()
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
      lookups++
      draw()
      // At ten skills there is no Add button: the focus stays in the list, on the last row.
      ;(skills.length < MAX_REVIEW_SKILLS ? addSkill : Array.from(el.querySelectorAll<HTMLElement>('.notes-skill .tool')).pop())?.focus()
    }

    async function remove(path: string): Promise<void> {
      if (!(await save((stored) => stored.filter((s) => s !== path), listError))) return
      draw()
      ;(adding ? input : addSkill).focus()
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

  function item(n: ReviewNote): HTMLElement {
    const index = files.findIndex((f) => (n.side === 'new' ? f.path : (f.oldPath ?? f.path)) === n.path)
    return h(
      'div',
      { class: `notes-item${n.resolvedAt !== undefined ? ' resolved' : ''}` },
      // A note of a file this tab does not have stays in the list without a way to it.
      h(
        'button',
        { class: 'notes-open', disabled: index < 0, onclick: () => reveal(index, n.id) },
        h(
          'span',
          { class: 'notes-where' },
          h('span', { class: 'path' }, `${n.path}:${lineSpan(n)}`),
          label(n.side === 'old' ? 'noteSideOld' : 'noteSideNew'),
          ...labels(n),
          h('span', { class: 'muted' }, t('noteMessages', { count: n.messages.length }))
        ),
        h('span', { class: 'mono muted' }, firstLine(n.quote)),
        h('span', null, firstLine(n.messages[0]?.body ?? ''))
      ),
      tool('drop', 'noteDeleteThread', () => void remove([n.id]))
    )
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
      // A note of other content (the file has changed since) has no card in this diff, whole file or not.
      if (!scroll() && note && note.blob === blobOf(note.side)) options.show(index, true, scroll)
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
    load,
    addFromSelection: add,
    dispose() {
      loads++
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('scroll', onScroll, true)
      addButton.remove()
      closeList?.()
    }
  }
}
