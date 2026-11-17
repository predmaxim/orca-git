// The Diff tab: the file the sidebar opened, with the other files of its selection one arrow away.
import type { DiffTabState } from '../shared/protocol.ts'
import { api, errorMessage, orca } from './api.ts'
import { mountDiff, showDiffPlaceholder, type DiffMode } from './diff.ts'
import { h } from './dom.ts'
import { revealToDo } from './revealonce.ts'
import { pickLocale, setLocale, t } from '../shared/i18n.ts'

setLocale(pickLocale(orca.locale))

// diagnostic, remove once the blank Diff tab is explained: what this frame goes through, in `orca plugin logs` (worker frame.trace).
const frameId = Math.random().toString(36).slice(2, 6)
const trace = (what: string) =>
  void orca.plugin
    .request('frame.trace', { line: `${frameId} ${what} | ${innerWidth}x${innerHeight} ${document.visibilityState} app=${JSON.stringify(document.getElementById('app')?.textContent?.slice(0, 40) ?? null)}`, locale: orca.locale })
    .catch(() => undefined)
trace('start')
;(globalThis as { __gitLogDiffStarted?: boolean }).__gitLogDiffStarted = true
addEventListener('error', (event) => trace(`error ${event.message}`))
addEventListener('unhandledrejection', (event) => trace(`rejection ${String(event.reason).slice(0, 120)}`))
document.addEventListener('visibilitychange', () => trace('visibility'))
let lastSize = `${innerWidth}x${innerHeight}`
addEventListener('resize', () => {
  // Only to or from nothing: a drag of a border fires many.
  const size = `${innerWidth}x${innerHeight}`
  if ((size === '0x0') !== (lastSize === '0x0')) trace(`resize from ${lastSize}`)
  lastSize = size
})

// The code's colors follow the `diffColors` setting (styles.css keys its palettes on this attribute); a change applies at once.
const applyColors = () =>
  void orca.settings
    .get()
    .then((settings) => (document.documentElement.dataset.diffColors = settings.diffColors === 'webstorm' ? 'webstorm' : 'orca'))
    .catch(() => undefined)
applyColors()
orca.settings.onDidChange(({ key }) => key === 'diffColors' && applyColors())

type Typography = { cssFontFamily: string; fontSize: number; fontWeight: string; lineHeight: number; fontLigatures: boolean }
/** Orca's file editor font, for the Orca colors; Monaco reads a line height under 8 as a multiple of the font size and 0 as its own default. */
const applyTypography = (font: Typography) => {
  const style = document.documentElement.style
  style.setProperty('--editor-font', font.cssFontFamily)
  style.setProperty('--editor-size', `${font.fontSize}px`)
  style.setProperty('--editor-weight', font.fontWeight)
  if (font.lineHeight >= 8) style.setProperty('--editor-line', `${font.lineHeight}px`)
  else if (font.lineHeight > 0) style.setProperty('--editor-line', String(font.lineHeight))
  else style.removeProperty('--editor-line')
  style.setProperty('--editor-ligatures', font.fontLigatures ? 'normal' : 'none')
}
if (orca.host.has('editor.readTypography')) {
  orca.host.call('editor.readTypography').then(applyTypography, () => undefined)
  orca.on('editor.typography.changed', applyTypography)
}

const PREFS_KEY = 'git-log.prefs.diff'

interface Prefs {
  diffMode?: DiffMode
  diffWholeFile?: boolean
  /** The agent the notes were last sent to. */
  noteAgent?: string
}

/** What localStorage keeps under `key` as JSON; null when nothing or not JSON. */
function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

const prefs: Prefs = { ...readJson<Prefs>(PREFS_KEY) }

const app = document.getElementById('app')!
/** The repository this tab belongs to, from its anchor file. */
let root: string | null = null
let view: ReturnType<typeof mountDiff> | null = null
/** The opening `view` shows. */
let shownOpen: string | null = null
/** The worker has a newer opening than `view`, which holds a note the user is writing: it shows once the editor closes. */
let waiting = false
let token = 0

/** Shows what the worker keeps for this tab's repository; the placeholder when it keeps nothing. */
async function show(): Promise<void> {
  const mine = ++token
  let state: DiffTabState | null = null
  let error: string | null = null
  try {
    state = root ? await api.diffState(root) : null
  } catch (caught) {
    error = errorMessage(caught)
  }
  trace(`state ${error ? `error ${error.slice(0, 80)}` : state ? `open ${state.open} ${state.index}/${state.files.length}` : `none (root ${root ? 'set' : 'none'})`}${mine !== token ? ' overtaken' : ''}`)
  if (mine !== token) return
  // The same opening read again (a new tab reads when it starts and on diff.show): the view stays, so its scroll to the note still comes.
  if (view && state && state.open === shownOpen) {
    waiting = false
    return
  }
  // What the user typed is not dropped for another opening (a click in Files or on a note of another commit): the view stays and says why.
  // Waiting first: hold() may step the view to the editor's file, and that step must not reach the worker.
  waiting = view !== null && state !== null
  if (waiting && view!.notes.hold(t('diffOpenWaits'))) return
  waiting = false
  view?.dispose()
  view = null
  if (error) app.replaceChildren(h('div', { class: 'diff-view' }, h('div', { class: 'diff-note error' }, error)))
  else if (!state) showDiffPlaceholder(app)
  else {
    // The last opening whose note this tab scrolled to: a second read of it (diff.show, a reload of the frame) does not scroll again.
    const revealed = `git-log.revealed.${state.root}`
    const reveal = revealToDo(state, localStorage.getItem(revealed))
    const wholeFile = Boolean(prefs.diffWholeFile)
    // Orca makes the tab anew each time it is shown again: the same opening and file open where the frame before left them.
    const place = `git-log.scroll.${state.root}`
    const left = readJson<{ open?: string; index?: number; whole?: boolean; top?: number }>(place)
    const scroll = !reveal && left?.open === state.open && left.index === state.index && left.whole === wholeFile && typeof left.top === 'number' ? left.top : undefined
    view = mountDiff(app, {
      root: state.root,
      files: state.files,
      index: state.index,
      mode: prefs.diffMode ?? (innerWidth < 1100 ? 'unified' : 'split'),
      wholeFile,
      onPrefs: (mode, wholeFile) => {
        prefs.diffMode = mode
        prefs.diffWholeFile = wholeFile
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      },
      noteAgent: prefs.noteAgent,
      onNoteAgent: (agent) => {
        prefs.noteAgent = agent
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      },
      // The worker keeps the index (a recreated tab opens on this file) and tells the sidebar; not while a newer opening waits, whose files the worker holds.
      onIndex: (index) => {
        if (!waiting) void api.diffIndex(state.root, index).catch(() => undefined)
      },
      onEditorClosed: () => {
        if (waiting) void show()
      },
      reveal: reveal ?? undefined,
      scroll,
      onScroll: (top, index, whole) => {
        try {
          localStorage.setItem(place, JSON.stringify({ open: state.open, index, whole, top }))
        } catch {
          // A refused localStorage only costs the place.
        }
      }
    })
    shownOpen = state.open
    if (reveal) localStorage.setItem(revealed, state.open)
  }
  // The first answer shows after a frame: what the tab holds then.
  requestAnimationFrame(() => requestAnimationFrame(() => trace('shown')))
}

async function start(): Promise<void> {
  // Orca makes the frame anew each time the tab is shown again, and a stopped worker starts first: not a blank tab meanwhile.
  app.replaceChildren(h('div', { class: 'diff-view' }, h('div', { class: 'diff-note muted' }, t('diffLoading'))))
  try {
    const anchor = JSON.parse((await orca.document!.get()).content.text ?? '{}')
    root = typeof anchor?.root === 'string' ? anchor.root : null
  } catch {
    root = null
  }
  trace(`document root ${root ?? 'none'}`)
  await show()
}

orca.plugin.on('diff.show', (payload: { root: string }) => {
  trace(`diff.show ${payload.root === root ? 'mine' : 'other'}`)
  if (root && payload.root === root) void show()
})

orca.plugin.on('notes.changed', (payload: { root: string }) => {
  if (root && payload.root === root) void view?.notes.load()
})

void start()
