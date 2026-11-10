import type { LogFilter, RefsResult } from '../shared/protocol.ts'
import { h, icon } from './dom.ts'
import { t } from '../shared/i18n.ts'
import { dayInput } from './format.ts'
import { showPopover } from './menu.ts'

export interface FilterHost {
  filter: LogFilter
  refs: RefsResult | null
  /** Applies a filter change and reloads the log. */
  apply(change: Partial<LogFilter>): void
}

const DAY = 86_400

function shortRef(full: string): string {
  return full.replace(/^refs\/(heads|remotes|tags)\//, '')
}

function summary(name: string, values: string[]): string {
  if (!values.length) return name
  return `${name}: ${values[0]}${values.length > 1 ? ` +${values.length - 1}` : ''}`
}

function filterButton(name: string, onOpen: (button: HTMLElement) => void, onClear: () => void) {
  const label = h('span', null, name)
  const clear = h('span', {
    class: 'clear',
    title: t('filterClearTip', { name: name.toLowerCase() }),
    onclick: (event: MouseEvent) => {
      event.stopPropagation()
      onClear()
    }
  }, icon('close'))
  const button: HTMLButtonElement = h(
    'button',
    { class: 'tool filter', onclick: () => onOpen(button) },
    label,
    icon('chevronDown'),
    clear
  )
  return {
    el: button,
    set(text: string, active: boolean) {
      label.textContent = text
      button.classList.toggle('set', active)
      button.title = text
    }
  }
}

/** A searchable checklist popover. */
function checklist(
  anchor: HTMLElement,
  groups: { title?: string; values: { value: string; label: string; icon?: HTMLElement | SVGElement }[] }[],
  selected: string[],
  onChange: (values: string[]) => void
) {
  const chosen = new Set(selected)
  const search = h('input', { class: 'field pop-search', placeholder: t('filterPlaceholder'), spellcheck: false }) as HTMLInputElement
  const list = h('div', null)
  const render = () => {
    const q = search.value.trim().toLowerCase()
    const all = h(
      'div',
      {
        class: `option${chosen.size ? '' : ' checked'}`,
        onclick: () => {
          chosen.clear()
          onChange([])
          render()
        }
      },
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
              class: `option${chosen.has(v.value) ? ' checked' : ''}`,
              title: v.value,
              onclick: () => {
                if (chosen.has(v.value)) chosen.delete(v.value)
                else chosen.add(v.value)
                onChange([...chosen])
                render()
              }
            },
            h('span', { class: 'check' }, icon('check')),
            v.icon ?? null,
            h('span', { class: 'label' }, v.label)
          )
        )
      }
    }
    list.replaceChildren(...parts)
  }
  search.addEventListener('input', render)
  render()
  showPopover(anchor, h('div', { style: 'min-width:240px' }, search, list))
}

export function createFilterBar(host: FilterHost) {
  const branch = filterButton(
    t('filterBranch'),
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
        (values) => host.apply({ branches: values })
      )
    },
    () => host.apply({ branches: [] })
  )

  const user = filterButton(
    t('filterUser'),
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
        (values) => host.apply({ users: values })
      )
    },
    () => host.apply({ users: [] })
  )

  let dateLabel = ''
  const date = filterButton(
    t('filterDate'),
    (anchor) => {
      const now = Math.floor(Date.now() / 1000)
      const preset = (label: string, days: number) =>
        h(
          'div',
          {
            class: `option${dateLabel === label ? ' checked' : ''}`,
            onclick: () => {
              dateLabel = label
              close()
              host.apply({ since: days ? now - days * DAY : undefined, until: undefined })
            }
          },
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
        h(
          'div',
          { style: 'min-width:240px' },
          preset(t('dateLast24h'), 1),
          preset(t('dateLast7d'), 7),
          preset(t('dateLast30d'), 30),
          h('div', { class: 'option-group' }, t('dateSelect')),
          h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-items:center;padding:4px 8px' }, t('dateFrom'), since, t('dateTo'), until),
          h('div', { style: 'display:flex;justify-content:flex-end;padding:4px 8px' }, apply)
        )
      )
    },
    () => {
      dateLabel = ''
      host.apply({ since: undefined, until: undefined })
    }
  )

  const paths = filterButton(
    t('filterPaths'),
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
        )
      )
    },
    () => host.apply({ paths: [] })
  )

  return {
    elements: [branch.el, user.el, date.el, paths.el],
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
