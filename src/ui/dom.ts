type Child = Node | string | number | null | undefined | false
type Props = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> }

/** Builds an element: `on*` props become listeners, the rest attributes or properties. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = String(value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key in el && key !== 'style' && key !== 'list') (el as any)[key] = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  append(el, children)
  return el
}

export function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : String(child))
  }
}

/**
 * Puts the rows of a tree into `container` with the keyboard of one: ↑/↓ move between rows, → opens a
 * closed folder or enters an open one, ← closes an open folder or goes up to the row's folder, Enter
 * clicks a row and Space a folder. A folder row has aria-expanded and opens or closes on click;
 * `depths[i]` is how deep `rows[i]` sits, one deeper than its folder. The tree is one Tab stop, and a
 * redraw keeps focus on the row with the same data-key.
 */
export function mountTree(container: HTMLElement, rows: HTMLElement[], depths: number[], cls?: string): void {
  const active = document.activeElement as HTMLElement | null
  const key = active && container.contains(active) ? active.dataset.key : undefined
  const tabStop = (row: EventTarget | undefined) => rows.forEach((r) => (r.tabIndex = r === row ? 0 : -1))
  const tree = h('div', {
    class: cls,
    role: 'tree',
    onfocusin: (event: FocusEvent) => tabStop(event.target ?? undefined),
    onkeydown: (event: KeyboardEvent) => {
      const i = rows.indexOf(event.target as HTMLElement)
      if (i < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const expanded = rows[i].getAttribute('aria-expanded') // null on a leaf
      if (event.key === 'Enter' || (event.key === ' ' && expanded) || (event.key === 'ArrowRight' && expanded === 'false') || (event.key === 'ArrowLeft' && expanded === 'true')) rows[i].click()
      else if (event.key === 'ArrowDown' || (event.key === 'ArrowRight' && expanded === 'true')) rows[i + 1]?.focus()
      else if (event.key === 'ArrowUp') rows[i - 1]?.focus()
      else if (event.key === 'ArrowLeft') rows[depths.lastIndexOf(depths[i] - 1, i)]?.focus()
      else return
      event.preventDefault()
    }
  }, ...rows)
  const kept = key === undefined ? undefined : rows.find((row) => row.dataset.key === key)
  tabStop(kept ?? rows[0])
  container.replaceChildren(tree)
  kept?.focus()
}

/** An inline SVG icon from the set below. */
export function icon(name: keyof typeof ICONS, cls = ''): SVGSVGElement {
  const tpl = document.createElement('template')
  tpl.innerHTML = `<svg class="icon ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name]}</svg>`
  return tpl.content.firstElementChild as SVGSVGElement
}

const stroke = (d: string) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`

export const ICONS = {
  branch: `<circle cx="5" cy="3.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="12.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11" cy="5.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>${stroke('M5 5v6M11 7c0 3-6 2-6 4')}`,
  tag: `${stroke('M2.5 2.5h5l6 6-5 5-6-6z')}<circle cx="5.5" cy="5.5" r="1" fill="currentColor"/>`,
  search: `<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.2"/>${stroke('M10.2 10.2 14 14')}`,
  refresh: stroke('M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3'),
  chevronDown: stroke('M4 6l4 4 4-4'),
  chevronRight: stroke('M6 4l4 4-4 4'),
  close: stroke('M4 4l8 8M12 4l-8 8'),
  tree: stroke('M2.5 3h11M2.5 3v10M2.5 8h4M2.5 13h4M9 8h4.5M9 13h4.5'),
  details: `<rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>${stroke('M9.5 2.5v11')}`,
  folder: stroke('M2 4.5h4l1.5 1.5H14v7H2z'),
  file: stroke('M4 2h5l3 3v9H4zM9 2v3h3'),
  up: stroke('M8 13V3M4 7l4-4 4 4'),
  down: stroke('M8 3v10M4 9l4 4 4-4'),
  star: `<path d="M8 2.2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5z" fill="currentColor"/>`,
  check: stroke('M3.5 8.5l3 3 6-7'),
  warning: `${stroke('M8 2l6.5 11.5h-13zM8 6.5v3.5')}<circle cx="8" cy="12" r=".7" fill="currentColor"/>`,
  copy: `<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>${stroke('M3.5 10.5h-1v-8h8v1')}`,
  cherry: `<circle cx="4.5" cy="11.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="11.5" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/>${stroke('M4.5 9.3C5 6 7 3.8 10 2.5M11.5 9.8C11 7 10.3 4.8 10 2.5M10 2.5c1.6.2 3 1 3.5 2.5')}`,
  checkout: stroke('M2.5 8h8M7.5 5l3 3-3 3M10.5 2.5h3v11h-3'),
  reset: stroke('M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3'),
  revert: stroke('M5.5 3.5l-3 3 3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7'),
  undo: stroke('M6.5 3L4 5.5 6.5 8M4 5.5h6a3 3 0 0 1 0 6H5.5'),
  edit: stroke('M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3'),
  fixup: stroke('M8 2.5v7M5 6.5l3 3 3-3M3 13.5h10'),
  squash: stroke('M8 1.5V6M5.5 3.5L8 6l2.5-2.5M8 14.5V10M5.5 12.5L8 10l2.5 2.5M3 8h10'),
  drop: stroke('M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5'),
  rebase: stroke('M2.5 4h7M2.5 8h7M2.5 12h7M12.5 3v10M10.5 11l2 2 2-2'),
  patch: stroke('M4 2h5l3 3v9H4zM9 2v3h3M6.5 8h3M8 6.5v3M6.5 11.5h3')
} as const

export function clear(el: Element): void {
  el.replaceChildren()
}
