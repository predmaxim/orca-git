import type { CommitDetails, CommitRow } from '../shared/protocol.ts'
import { t } from '../shared/i18n.ts'
import { h, icon } from './dom.ts'
import { fullDate, shortHash } from './format.ts'

export interface CommitListHost {
  /** Hashes of the open rows; the list reads and changes it. */
  expanded: Set<string>
  load(hash: string): Promise<CommitDetails>
  select(hash: string): void
  /** Runs after a row opened or closed. */
  onToggle(): void
}

export function renderPlaceholder(container: HTMLElement, text: string): void {
  container.replaceChildren(h('div', { class: 'cl-note' }, text))
}

function renderBody(d: CommitDetails, host: CommitListHost): HTMLElement {
  const parents = d.parents.map((p, i) => h('span', null, i ? ', ' : '', h('a', { class: 'hash-link mono', title: p, onclick: () => host.select(p) }, shortHash(p))))
  const more = d.branches.length >= 50 ? '+' : ''
  return h(
    'div',
    { class: 'cl-body' },
    h('div', { class: 'cl-message mono' }, d.message),
    h('div', null, h('strong', null, d.author), ' ', h('span', { class: 'muted' }, `<${d.email}>`)),
    h('div', { class: 'muted' }, fullDate(d.authorTime)),
    d.committer !== d.author || d.commitTime !== d.authorTime
      ? h('div', { class: 'muted' }, t('detailsCommittedBy', { name: d.committer, date: fullDate(d.commitTime) }))
      : null,
    parents.length ? h('div', null, h('span', { class: 'muted' }, `${t('detailsParents', { count: parents.length })}: `), ...parents) : null,
    h(
      'div',
      null,
      d.branches.length
        ? h('span', null, h('span', { class: 'muted' }, `${t('detailsBranches', { count: d.branches.length, n: `${d.branches.length}${more}` })}: `), d.branches.join(', '))
        : h('span', { class: 'muted' }, t('detailsNoBranches'))
    ),
    h('div', { class: 'mono muted' }, d.hash)
  )
}

/** One row per commit, in the order given; a click opens the full description under the row. */
export function renderCommitList(container: HTMLElement, commits: CommitRow[], host: CommitListHost): void {
  const rows = commits.map((commit) => {
    const chevron = h('span', { class: 'cl-chevron' })
    const body = h('div', { class: 'cl-slot' })
    const head = h(
      'div',
      { class: 'cl-head', tabindex: '0', role: 'button' },
      chevron,
      h('span', { class: 'mono muted' }, shortHash(commit.hash)),
      h('span', { class: 'cl-subject', title: commit.subject }, commit.subject),
      h('span', { class: 'cl-author muted' }, commit.author)
    )
    let loaded = false
    const show = () => {
      const open = host.expanded.has(commit.hash)
      head.setAttribute('aria-expanded', String(open))
      chevron.replaceChildren(icon(open ? 'chevronDown' : 'chevronRight'))
      body.hidden = !open
      if (!open || loaded) return
      loaded = true
      body.replaceChildren(h('div', { class: 'muted' }, t('diffLoading')))
      host.load(commit.hash).then(
        (details) => body.replaceChildren(renderBody(details, host)),
        (error) => {
          loaded = false
          body.replaceChildren(h('div', { class: 'muted' }, error instanceof Error ? error.message : String(error)))
        }
      )
    }
    const toggle = () => {
      if (!host.expanded.delete(commit.hash)) host.expanded.add(commit.hash)
      show()
      host.onToggle()
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
    show()
    return h('div', { class: 'cl-item' }, head, body)
  })
  container.replaceChildren(h('div', { class: 'cl-list' }, ...rows))
}
