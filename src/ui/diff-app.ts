// The Diff tab: the file the sidebar opened, with the other files of its selection one arrow away.
import type { DiffTabState } from '../shared/protocol.ts'
import { api, errorMessage, orca } from './api.ts'
import { mountDiff, showDiffPlaceholder, type DiffMode } from './diff.ts'
import { h } from './dom.ts'
import { revealToDo } from './revealonce.ts'
import { pickLocale, setLocale } from '../shared/i18n.ts'

setLocale(pickLocale(orca.locale))

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

const prefs: Prefs = (() => {
  try {
    return { ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return {}
  }
})()

const app = document.getElementById('app')!
/** The repository this tab belongs to, from its anchor file. */
let root: string | null = null
let view: ReturnType<typeof mountDiff> | null = null
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
  if (mine !== token) return
  view?.dispose()
  view = null
  if (error) app.replaceChildren(h('div', { class: 'diff-view' }, h('div', { class: 'diff-note error' }, error)))
  else if (!state) showDiffPlaceholder(app)
  else {
    // The last opening whose note this tab scrolled to: a second read of it (diff.show, a reload of the frame) does not scroll again.
    const revealed = `git-log.revealed.${state.root}`
    const reveal = revealToDo(state, localStorage.getItem(revealed))
    view = mountDiff(app, {
      root: state.root,
      files: state.files,
      index: state.index,
      mode: prefs.diffMode ?? (innerWidth < 1100 ? 'unified' : 'split'),
      wholeFile: Boolean(prefs.diffWholeFile),
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
      // The worker keeps the index (a recreated tab opens on this file) and tells the sidebar.
      onIndex: (index) => void api.diffIndex(state.root, index).catch(() => undefined),
      reveal: reveal ?? undefined
    })
    if (reveal) localStorage.setItem(revealed, state.open)
  }
}

async function start(): Promise<void> {
  try {
    const anchor = JSON.parse((await orca.document!.get()).content.text ?? '{}')
    root = typeof anchor?.root === 'string' ? anchor.root : null
  } catch {
    root = null
  }
  await show()
}

orca.plugin.on('diff.show', (payload: { root: string }) => {
  if (root && payload.root === root) void show()
})

orca.plugin.on('notes.changed', (payload: { root: string }) => {
  if (root && payload.root === root) void view?.notes.load()
})

void start()
