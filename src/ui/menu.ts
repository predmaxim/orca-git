import { h, icon, ICONS } from './dom.ts'
import { keyFor, pickByKey, type KeyId } from './keys.ts'

export type MenuEntry =
  | 'separator'
  | {
      label: string
      icon?: keyof typeof ICONS
      shortcut?: string
      /** Its key: shown on the right, and pressing it in the open menu runs the item. */
      key?: KeyId
      disabled?: boolean
      /** Why it is disabled, shown as a tooltip. */
      hint?: string
      run: () => void
    }

let closeCurrent: (() => void) | null = null

export function closePopups(): void {
  closeCurrent?.()
}

function place(el: HTMLElement, x: number, y: number, alignRight = 0): void {
  document.body.append(el)
  const { width, height } = el.getBoundingClientRect()
  const left = Math.max(4, Math.min(x - alignRight, innerWidth - width - 4))
  const top = y + height > innerHeight - 4 ? Math.max(4, innerHeight - height - 4) : y
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

/** Opens `el` above everything; closes on outside press, Escape or blur. Returns the closer. */
function open(el: HTMLElement, onClose?: () => void): () => void {
  closePopups()
  const layer = h('div', { class: 'layer' })
  const close = () => {
    if (closeCurrent !== close) return
    closeCurrent = null
    layer.remove()
    el.remove()
    removeEventListener('blur', close)
    removeEventListener('resize', close)
    document.removeEventListener('keydown', onKey, true)
    onClose?.()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
  layer.addEventListener('mousedown', (event) => {
    event.preventDefault()
    close()
  })
  layer.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    close()
  })
  document.body.append(layer)
  addEventListener('blur', close)
  addEventListener('resize', close)
  document.addEventListener('keydown', onKey, true)
  closeCurrent = close
  return close
}

export function showMenu(x: number, y: number, entries: MenuEntry[], restoreFocus?: HTMLElement): void {
  const items: { el: HTMLElement; entry: Exclude<MenuEntry, 'separator'> }[] = []
  const menu = h('div', { class: 'menu', role: 'menu', tabindex: -1 })
  const withIcons = entries.some((entry) => entry !== 'separator' && entry.icon)
  let active = -1
  const setActive = (index: number) => {
    items[active]?.el.classList.remove('active')
    active = index
    items[active]?.el.classList.add('active')
    items[active]?.el.scrollIntoView({ block: 'nearest' })
  }
  const close = open(menu, () => restoreFocus?.focus({ preventScroll: true }))
  const choose = (index: number) => {
    const item = items[index]
    if (!item || item.entry.disabled) return
    close()
    item.entry.run()
  }
  entries.forEach((entry, i) => {
    if (entry === 'separator') {
      if (i > 0 && entries[i - 1] !== 'separator' && i < entries.length - 1) menu.append(h('div', { class: 'menu-sep' }))
      return
    }
    const index = items.length
    const el = h(
      'div',
      {
        class: `menu-item${entry.disabled ? ' disabled' : ''}`,
        role: 'menuitem',
        title: entry.disabled ? entry.hint : undefined,
        onmouseenter: () => setActive(index),
        onmouseleave: () => setActive(-1),
        onclick: () => choose(index)
      },
      withIcons ? h('span', { class: 'menu-icon' }, entry.icon ? icon(entry.icon) : null) : null,
      h('span', { class: 'label' }, entry.label),
      entry.shortcut || entry.key ? h('span', { class: 'shortcut' }, entry.shortcut ?? keyFor(entry.key)?.shown) : null
    )
    items.push({ el, entry })
    menu.append(el)
  })
  menu.addEventListener('keydown', (event) => {
    const picked = pickByKey(items.map((item) => item.entry), event)
    if (picked) {
      event.preventDefault()
      choose(items.findIndex((item) => item.entry === picked))
      return
    }
    const enabled = items.map((item, i) => (item.entry.disabled ? -1 : i)).filter((i) => i >= 0)
    if (!enabled.length) return
    const pos = enabled.indexOf(active)
    if (event.key === 'ArrowDown') setActive(enabled[(pos + 1) % enabled.length])
    else if (event.key === 'ArrowUp') setActive(enabled[(pos - 1 + enabled.length) % enabled.length])
    else if (event.key === 'Enter' || event.key === ' ') choose(active)
    else return
    event.preventDefault()
  })
  place(menu, x, y)
  menu.focus({ preventScroll: true })
}

/** A popover under `anchor`, for filters. */
export function showPopover(anchor: HTMLElement, content: HTMLElement, onClose?: () => void): () => void {
  const pop = h('div', { class: 'popover' }, content)
  const close = open(pop, onClose)
  const rect = anchor.getBoundingClientRect()
  place(pop, rect.left, rect.bottom + 4)
  // The first control, or the first option (tabindex -1) when options come before any field, as Date's presets do.
  const focusable = pop.querySelector<HTMLElement>('input, textarea, select, button, [tabindex]')
  focusable?.focus()
  return close
}
