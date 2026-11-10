// The panel's keys: digits move between areas, f folds one, / searches it, letters press what the area shows.
import { findKey, type KeyId } from './keys.ts'
import type { SectionId } from './sections.ts'

export interface PanelArea {
  /** The section, `data-section`; it carries the area line. */
  root: HTMLElement
  /** Gets tabindex="-1": focus lands here when `target()` has nothing. */
  body: HTMLElement
  /** The header's sec-toggle. */
  toggle: HTMLElement
  /** Where a digit puts focus; null means the body. */
  target(): HTMLElement | null
  search?: HTMLInputElement
}

export interface PanelKeysHost {
  areas: Record<SectionId, PanelArea>
  isOpen(id: SectionId): boolean
  /** As a click on the header: the last open area stays open. */
  toggle(id: SectionId): void
  run: Partial<Record<KeyId, () => void>>
}

const AREA_KEYS: Partial<Record<KeyId, SectionId>> = { area1: 'branches', area2: 'commits', area3: 'files', area4: 'details' }
// Where keys belong to what is typed or chosen: fields, menus, dialogs.
const TYPING = 'input, textarea, select, [contenteditable], .overlay, .menu, .popover'

export function mountPanelKeys(host: PanelKeysHost): void {
  const ids = Object.keys(host.areas) as SectionId[]
  for (const id of ids) host.areas[id].body.tabIndex = -1
  // The area focus was last in: it keeps the line while focus is outside the panel.
  let current: SectionId | null = null

  document.addEventListener('focusin', (event) => {
    const id = ids.find((other) => host.areas[other].root.contains(event.target as Node))
    if (!id || id === current) return
    if (current) host.areas[current].root.classList.remove('current-area')
    host.areas[id].root.classList.add('current-area')
    current = id
  })

  const open = (id: SectionId) => {
    if (!host.isOpen(id)) host.toggle(id)
  }
  const enter = (id: SectionId) => {
    open(id)
    const area = host.areas[id]
    ;(area.target() ?? area.body).focus()
  }

  document.addEventListener('keydown', (event) => {
    // A menu or popover (.layer), a dialog (.overlay) or the busy spinner owns the keys, even once focus fell to body.
    if (event.defaultPrevented || document.querySelector('.busy, .overlay, .layer')) return
    const id = current
    const search = id ? host.areas[id].search : undefined
    // Esc with text is the field's own: it clears it and prevents the key.
    if (event.key === 'Escape' && search && event.target === search && !search.value) {
      event.preventDefault()
      enter(id!)
      return
    }
    if ((event.target as Element).closest?.(TYPING)) return
    const key = findKey(event, id ? ['anywhere', id] : ['anywhere'])
    if (!key) return
    const area = AREA_KEYS[key.id]
    if (area) {
      enter(area)
    } else if (key.id === 'fold') {
      if (!id) return
      const was = host.isOpen(id)
      host.toggle(id)
      if (host.isOpen(id) !== was) host.areas[id].toggle.focus()
    } else if (key.id === 'search') {
      if (!search) return
      open(id!)
      search.focus()
      search.select()
    } else {
      // A folded area's letters press its controls only after it opens.
      if (key.scope === id) open(id)
      host.run[key.id]?.()
    }
    event.preventDefault()
  })
}
