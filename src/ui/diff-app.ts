// The Diff tab: the file the sidebar opened, with the other files of its selection one arrow away.
import type { DiffTabState } from '../shared/protocol.ts'
import { api, errorMessage, orca } from './api.ts'
import { mountDiff, showDiffPlaceholder, type DiffMode } from './diff.ts'
import { h } from './dom.ts'
import { pickLocale, setLocale } from '../shared/i18n.ts'

setLocale(pickLocale(orca.locale))

const PREFS_KEY = 'git-log.prefs.diff'

interface Prefs {
  diffMode?: DiffMode
  diffWholeFile?: boolean
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
let view: { dispose(): void } | null = null
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
      // The worker keeps the index (a recreated tab opens on this file) and tells the sidebar.
      onIndex: (index) => void api.diffIndex(state.root, index).catch(() => undefined)
    })
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

void start()
