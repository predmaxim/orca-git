// The panel's keys: digits move between areas, / searches one, Shift+letters press the panel's own controls, letters
// run the menu items of the commits or branch under the cursor, and Space opens that menu.
import { t } from '../shared/i18n.ts'
import { findKey, type KeyBinding, type KeyId } from './keys.ts'
import { showMenu, type MenuEntry } from './menu.ts'
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

/** The menu of what is under the cursor in an area, and where to open it. */
export interface EntityTarget {
  entries: MenuEntry[]
  x: number
  y: number
  /** Gets focus back when the menu closes. */
  restore?: HTMLElement
}

export interface PanelKeysHost {
  areas: Record<SectionId, PanelArea>
  isOpen(id: SectionId): boolean
  /** As a click on the header: the last open area stays open. */
  toggle(id: SectionId): void
  run: Partial<Record<KeyId, () => void>>
  /** The menu of the commits or branch under the cursor; null when there is none. */
  menu(id: SectionId): EntityTarget | null
  /** Says why a letter did nothing. */
  notice(text: string): void
}

/** What a letter does: the menu item with its key, or why nothing runs. */
export function entityAction(binding: KeyBinding, entries: MenuEntry[] | null): { run: () => void } | { notice: string } {
  if (!entries) return { notice: t('keyNoTarget') }
  const entry = entries.find((e): e is Exclude<MenuEntry, 'separator'> => e !== 'separator' && e.key === binding.id)
  if (!entry) return { notice: t('keyNotHere', { action: t(binding.label) }) }
  if (entry.disabled) return { notice: entry.hint ?? t('keyUnavailable', { action: t(binding.label) }) }
  return { run: entry.run }
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
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey
    // Space on a folder row never gets here: the tree opens or closes the folder and prevents the key. On a button,
    // Space presses the button.
    const space = event.key === ' ' && !event.shiftKey && !(event.target as Element).closest?.('button, a, [role=button]')
    if (plain && id && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey) || space)) {
      const target = host.menu(id)
      if (!target) return
      event.preventDefault()
      showMenu(target.x, target.y, target.entries, target.restore)
      return
    }
    const key = findKey(event, id ? ['anywhere', id] : ['anywhere'])
    if (!key) return
    const area = AREA_KEYS[key.id]
    if (key.menu) {
      const action = entityAction(key, host.menu(id!)?.entries ?? null)
      if ('run' in action) action.run()
      else host.notice(action.notice)
    } else if (area) {
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
