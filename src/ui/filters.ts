import type { LogFilter, RefsResult } from '../shared/protocol.ts'
import { h, icon } from './dom.ts'
import { t } from '../shared/i18n.ts'
import { dayInput } from './format.ts'
import { withKey, type KeyId } from './keys.ts'
import { showPopover } from './menu.ts'

export interface FilterHost {
  filter: LogFilter
  refs: RefsResult | null
  /** Applies a filter change and reloads the log. */
  apply(change: Partial<LogFilter>): void
  /** Takes focus back to the commit list when a closing popover took it along (Esc, a picked date). */
  focusList(): void
}

const DAY = 86_400

function shortRef(full: string): string {
  return full.replace(/^refs\/(heads|remotes|tags)\//, '')
}

function summary(name: string, values: string[]): string {
  if (!values.length) return name
  return `${name}: ${values[0]}${values.length > 1 ? ` +${values.length - 1}` : ''}`
}

/** An option of a popover list: focusable by the arrows (see `optionKeys`), `value` names it across redraws. */
const optionProps = (checked: boolean, value: string, onclick: () => void) => ({
  class: `option${checked ? ' checked' : ''}`,
  tabindex: -1,
  role: 'option',
  'aria-selected': String(checked),
  dataset: { value },
  onclick
})

/** ↑/↓ move between the popover's search field and its options; Enter or Space picks the focused option. */
function optionKeys(root: HTMLElement): HTMLElement {
  root.addEventListener('keydown', (event) => {
    const items = Array.from(root.querySelectorAll<HTMLElement>('.pop-search, .option'))
    const i = items.indexOf(event.target as HTMLElement)
    if (i < 0 || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') items[i + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
    else if (items[i].classList.contains('option') && (event.key === 'Enter' || event.key === ' ')) items[i].click()
    else return
    event.preventDefault()
  })
  return root
}

function filterButton(name: string, key: KeyId, onOpen: (button: HTMLElement) => void, onClear: () => void) {
  const label = h('span', null, name)
  const clear = h('span', {
    class: 'clear',
    title: withKey(t('filterClearTip', { name: name.toLowerCase() }), key),
    onclick: (event: MouseEvent) => {
      event.stopPropagation()
      onClear()
    }
  }, icon('close'))
  const button: HTMLButtonElement = h(
    'button',
    { class: 'tool filter', title: withKey(name, key), onclick: () => onOpen(button) },
    label,
    icon('chevronDown'),
    clear
  )
  return {
    el: button,
    clear: onClear,
    set(text: string, active: boolean) {
      label.textContent = text
      button.classList.toggle('set', active)
      button.title = withKey(text, key)
    }
  }
}

/** A searchable checklist popover. */
function checklist(
  anchor: HTMLElement,
  groups: { title?: string; values: { value: string; label: string; icon?: HTMLElement | SVGElement }[] }[],
  selected: string[],
  onChange: (values: string[]) => void,
  onClose: () => void
) {
  const chosen = new Set(selected)
  const search = h('input', { class: 'field pop-search', placeholder: t('filterPlaceholder'), spellcheck: false }) as HTMLInputElement
  const list = h('div', null)
  const render = () => {
    // Space or a click redraws the list: focus stays on the same option.
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.value : undefined
    const q = search.value.trim().toLowerCase()
    const all = h(
      'div',
      optionProps(!chosen.size, '', () => {
        chosen.clear()
        onChange([])
        render()
      }),
      h('span', { class: 'check' }, icon('check')),
      h('span', { class: 'label' }, t('filterAll'))
    )
    const parts: HTMLElement[] = q ? [] : [all]
    for (const group of groups) {
      const values = group.values.filter((v) => !q || v.label.toLowerCase().includes(q))
      if (!values.length) continue
      if (group.title) parts.push(h('div', { class: 'option-group' }, group.title))
      for (const v of values) {
        parts.push(
          h(
            'div',
            {
              ...optionProps(chosen.has(v.value), v.value, () => {
                if (chosen.has(v.value)) chosen.delete(v.value)
                else chosen.add(v.value)
                onChange([...chosen])
                render()
              }),
              title: v.value
            },
            h('span', { class: 'check' }, icon('check')),
            v.icon ?? null,
            h('span', { class: 'label' }, v.label)
          )
        )
      }
    }
    list.replaceChildren(...parts)
    if (focused !== undefined) list.querySelector<HTMLElement>(`[data-value="${CSS.escape(focused)}"]`)?.focus()
  }
  search.addEventListener('input', render)
  render()
  showPopover(anchor, optionKeys(h('div', { style: 'min-width:240px' }, search, list)), onClose)
}

export function createFilterBar(host: FilterHost) {
  // Esc, a picked option and a click outside (the layer takes that click) all leave focus on body: back to the list.
  const closed = () => {
    if (!document.activeElement || document.activeElement === document.body) host.focusList()
  }
  const branch = filterButton(
    t('filterBranch'),
    'filterBranch',
    (anchor) => {
      const refs = host.refs
      if (!refs) return
      const item = (full: string, name: string, kind: 'local' | 'remote' | 'tag') => ({
        value: full,
        label: name,
        icon: icon(kind === 'tag' ? 'tag' : 'branch', `ic-${kind}`)
      })
      checklist(
        anchor,
        [
          { values: refs.head.hash ? [{ value: 'HEAD', label: t('headCurrent') }] : [] },
          { title: t('groupLocal'), values: refs.locals.map((r) => item(r.full, r.name, 'local')) },
          { title: t('groupRemote'), values: refs.remotes.map((r) => item(r.full, r.name, 'remote')) },
          { title: t('groupTags'), values: refs.tags.map((r) => item(r.full, r.name, 'tag')) }
        ],
        host.filter.branches ?? [],
        (values) => host.apply({ branches: values }),
        closed
      )
    },
    () => host.apply({ branches: [] })
  )

  const user = filterButton(
    t('filterUser'),
    'filterUser',
    (anchor) => {
      const refs = host.refs
      if (!refs) return
      const me = refs.me
      checklist(
        anchor,
        [
          { values: me ? [{ value: me, label: t('filterMe', { name: me }) }] : [] },
          { title: t('groupUsers'), values: refs.users.filter((u) => u !== me).map((u) => ({ value: u, label: u })) }
        ],
        host.filter.users ?? [],
        (values) => host.apply({ users: values }),
        closed
      )
    },
    () => host.apply({ users: [] })
  )

  let dateLabel = ''
  const date = filterButton(
    t('filterDate'),
    'filterDate',
    (anchor) => {
      const now = Math.floor(Date.now() / 1000)
      const preset = (label: string, days: number) =>
        h(
          'div',
          optionProps(dateLabel === label, label, () => {
            dateLabel = label
            close()
            host.apply({ since: days ? now - days * DAY : undefined, until: undefined })
          }),
          h('span', { class: 'check' }, icon('check')),
          h('span', { class: 'label' }, label)
        )
      const toInput = (seconds?: number) => (seconds ? dayInput(seconds) : '')
      const since = h('input', { class: 'field', type: 'date', value: toInput(host.filter.since) }) as HTMLInputElement
      const until = h('input', { class: 'field', type: 'date', value: toInput(host.filter.until) }) as HTMLInputElement
      const apply = h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            const from = since.value ? Math.floor(new Date(`${since.value}T00:00:00`).getTime() / 1000) : undefined
            const to = until.value ? Math.floor(new Date(`${until.value}T23:59:59`).getTime() / 1000) : undefined
            dateLabel = from && to ? `${since.value} – ${until.value}` : from ? t('dateSince', { date: since.value }) : to ? t('dateUntil', { date: until.value }) : ''
            close()
            host.apply({ since: from, until: to })
          }
        },
        t('apply')
      )
      const close = showPopover(
        anchor,
        optionKeys(h(
          'div',
          { style: 'min-width:240px' },
          preset(t('dateLast24h'), 1),
          preset(t('dateLast7d'), 7),
          preset(t('dateLast30d'), 30),
          h('div', { class: 'option-group' }, t('dateSelect')),
          h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-items:center;padding:4px 8px' }, t('dateFrom'), since, t('dateTo'), until),
          h('div', { style: 'display:flex;justify-content:flex-end;padding:4px 8px' }, apply)
        )),
        closed
      )
    },
    () => {
      dateLabel = ''
      host.apply({ since: undefined, until: undefined })
    }
  )

  const paths = filterButton(
    t('filterPaths'),
    'filterPaths',
    (anchor) => {
      const area = h('textarea', { class: 'field mono', rows: 5, spellcheck: false, placeholder: t('pathsPlaceholder') }) as HTMLTextAreaElement
      area.value = (host.filter.paths ?? []).join('\n')
      const submit = () => {
        close()
        host.apply({ paths: area.value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean) })
      }
      area.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit()
      })
      const close = showPopover(
        anchor,
        h(
          'div',
          { style: 'display:flex;flex-direction:column;gap:6px;padding:4px;width:320px' },
          area,
          h('div', { style: 'display:flex;justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: submit }, t('apply')))
        ),
        closed
      )
    },
    () => host.apply({ paths: [] })
  )

  return {
    elements: [branch.el, user.el, date.el, paths.el],
    /** Clears each filter as its cross does, in the same order. */
    clear: [branch.clear, user.clear, date.clear, paths.clear],
    /** Syncs the button labels with the current filter. */
    update() {
      const f = host.filter
      const branches = (f.branches ?? []).map(shortRef)
      branch.set(summary(t('filterBranch'), branches), branches.length > 0)
      user.set(summary(t('filterUser'), f.users ?? []), (f.users ?? []).length > 0)
      if (!f.since && !f.until) dateLabel = ''
      date.set(dateLabel ? `${t('filterDate')}: ${dateLabel}` : t('filterDate'), Boolean(f.since || f.until))
      paths.set(summary(t('filterPaths'), f.paths ?? []), (f.paths ?? []).length > 0)
    }
  }
}
