// A column of collapsible sections stacked like the WebStorm Git tool window. Pure prefs logic on top, DOM below.
import { t, type MessageKey } from '../shared/i18n.ts'
import { h, icon } from './dom.ts'

export type SectionId = 'branches' | 'commits' | 'files' | 'details'

export interface SectionPrefs {
  collapsed: Record<SectionId, boolean>
  /** Open sections share the column height in proportion to their weights. */
  weights: Record<SectionId, number>
}

const IDS: SectionId[] = ['branches', 'commits', 'files', 'details']
const WEIGHTS: Record<SectionId, number> = { branches: 1, commits: 2, files: 1.5, details: 1 }
const TITLES: Record<SectionId, MessageKey> = {
  branches: 'sectionBranches',
  commits: 'sectionCommits',
  files: 'sectionFiles',
  details: 'sectionDetails'
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})
const isWeight = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Section prefs read back from storage: anything missing or broken falls back to the defaults. */
export function normalizeSections(stored: unknown): SectionPrefs {
  const collapsed = record(record(stored).collapsed)
  const weights = record(record(stored).weights)
  const prefs: SectionPrefs = {
    collapsed: Object.fromEntries(IDS.map((id) => [id, collapsed[id] === true])) as Record<SectionId, boolean>,
    weights: Object.fromEntries(IDS.map((id) => [id, isWeight(weights[id]) ? weights[id] : WEIGHTS[id]])) as Record<SectionId, number>
  }
  if (IDS.every((id) => prefs.collapsed[id])) prefs.collapsed.commits = false
  return prefs
}

/** Moves `deltaPx` of height from `below` to `above`; the pair keeps its sum and neither drops under `minPx`. */
export function resizePair(
  weights: Record<SectionId, number>,
  above: SectionId,
  below: SectionId,
  deltaPx: number,
  pxPerWeight: number,
  minPx = 48
): Record<SectionId, number> {
  const total = weights[above] + weights[below]
  const min = minPx / pxPerWeight
  if (total < 2 * min) return { ...weights }
  let a = weights[above] + deltaPx / pxPerWeight
  let b = weights[below] - deltaPx / pxPerWeight
  if (a < min) {
    a = min
    b = total - min
  } else if (b < min) {
    b = min
    a = total - min
  }
  return { ...weights, [above]: a, [below]: b }
}

export interface Section {
  body: HTMLElement
  /** Chevron, title and summary; buttons appended here sit at its right end and don't collapse it. */
  header: HTMLElement
  setSummary(text: string): void
}

/** Builds the sections `ids` from top to bottom; `onChange` runs after a collapse or a resize, to save `prefs`. */
export function createColumn(ids: SectionId[], prefs: SectionPrefs, onChange: () => void): { element: HTMLElement; section(id: SectionId): Section } {
  const element = h('div', { class: 'column' })
  const parts = new Map<SectionId, Section & { root: HTMLElement; toggle: HTMLElement; splitter: HTMLElement | null }>()

  /** The nearest open section above `index`: the splitter above an open section resizes against it. */
  const openAbove = (index: number): SectionId | undefined => {
    for (let i = index - 1; i >= 0; i--) if (!prefs.collapsed[ids[i]]) return ids[i]
    return undefined
  }

  const layout = () => {
    ids.forEach((id, index) => {
      const part = parts.get(id)!
      const open = !prefs.collapsed[id]
      part.root.classList.toggle('collapsed', !open)
      part.root.style.flexGrow = open ? String(prefs.weights[id]) : ''
      part.toggle.setAttribute('aria-expanded', String(open))
      part.toggle.firstElementChild!.replaceWith(icon(open ? 'chevronDown' : 'chevronRight'))
      if (part.splitter) part.splitter.hidden = !open || !openAbove(index)
    })
  }

  ids.forEach((id, index) => {
    const toggle = h('button', { class: 'sec-toggle' }, icon('chevronDown'), h('span', { class: 'sec-title' }, t(TITLES[id])))
    const summary = h('span', { class: 'sec-summary' })
    const header = h('div', { class: 'sec-head' }, toggle, summary)
    header.addEventListener('click', (event) => {
      const button = (event.target as Element).closest('button')
      if (button && button !== toggle) return
      prefs.collapsed[id] = !prefs.collapsed[id]
      layout()
      onChange()
    })
    const body = h('div', { class: `sec-body ${id}` })
    const splitter = index ? h('div', { class: 'col-splitter' }) : null
    splitter?.addEventListener('mousedown', (event) => {
      const above = openAbove(index)
      if (!above || prefs.collapsed[id]) return
      event.preventDefault()
      const open = ids.filter((other) => !prefs.collapsed[other])
      const px = open.reduce((sum, other) => sum + parts.get(other)!.root.getBoundingClientRect().height, 0)
      const weight = open.reduce((sum, other) => sum + prefs.weights[other], 0)
      const start = prefs.weights
      const move = (e: MouseEvent) => {
        prefs.weights = resizePair(start, above, id, e.clientY - event.clientY, px / weight)
        layout()
      }
      const up = () => {
        removeEventListener('mousemove', move)
        removeEventListener('mouseup', up)
        onChange()
      }
      addEventListener('mousemove', move)
      addEventListener('mouseup', up)
    })
    const root = h('section', { class: 'col-section', dataset: { section: id } }, header, body)
    element.append(...(splitter ? [splitter, root] : [root]))
    parts.set(id, { root, toggle, splitter, header, body, setSummary: (text) => (summary.textContent = text) })
  })

  layout()
  return { element, section: (id) => parts.get(id)! }
}
