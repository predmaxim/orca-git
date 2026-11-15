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
  // The focused row is gone (its folder closed): focus moves to the deepest folder still drawn above it, else the first row.
  const heir = key === undefined || kept ? kept : (rows.filter((row) => key.startsWith(`${row.dataset.key}/`)).pop() ?? rows[0])
  tabStop(heir ?? rows[0])
  container.replaceChildren(tree)
  heir?.focus()
}

/** An inline SVG icon from the set below; decorative, its button or text carries the meaning. Its size comes from CSS. */
export function icon(name: keyof typeof ICONS, cls = ''): SVGSVGElement {
  const tpl = document.createElement('template')
  tpl.innerHTML =
    `<svg class="icon ${cls}" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
  return tpl.content.firstElementChild as SVGSVGElement
}

// Icons: Lucide (https://lucide.dev), the set Orca draws its own UI with, so the panel looks like the app around it.
// Lucide is under the ISC License:
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c)
//   for Lucide are held by Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
//   provided that the above copyright notice and this permission notice appear in all copies.
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
//   INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
//   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
//   THIS SOFTWARE.
// Bodies from lucide-static 0.469.0; the Lucide name of each is in its comment.
export const ICONS = {
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>', // git-branch
  commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>', // git-commit-horizontal
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>', // tag
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', // search
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>', // refresh-cw
  chevronDown: '<path d="m6 9 6 6 6-6"/>', // chevron-down
  chevronRight: '<path d="m9 18 6-6-6-6"/>', // chevron-right
  expandAll: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>', // chevrons-up-down
  collapseAll: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>', // chevrons-down-up
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', // x
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', // arrow-up
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>', // arrow-down
  left: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', // arrow-left
  incoming: '<path d="M17 7 7 17"/><path d="M17 17H7V7"/>', // arrow-down-left
  outgoing: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>', // arrow-up-right
  right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', // arrow-right
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>', // star
  check: '<path d="M20 6 9 17l-5-5"/>', // check
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', // triangle-alert
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>', // loader-circle
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', // copy
  cherry: '<path d="M2 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"/><path d="M12 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"/><path d="M7 14c3.22-2.91 4.29-8.75 5-12 1.66 2.38 4.94 9 5 12"/><path d="M22 9c-4.29 0-7.14-2.33-10-7 5.71 0 10 4.67 10 7Z"/>', // cherry
  checkout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>', // log-in
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', // rotate-ccw
  revert: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>', // undo-2
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>', // undo
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>', // pencil
  fixup: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>', // arrow-down-to-line
  squash: '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/>', // fold-vertical
  drop: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>', // trash-2
  rebase: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>', // arrow-down-wide-narrow
  patch: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>', // file-diff
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' // message-square
} as const

export function clear(el: Element): void {
  el.replaceChildren()
}
