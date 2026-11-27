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

function renderBody(d: CommitDetails, subject: string, host: CommitListHost): HTMLElement {
  const [firstLine, ...lines] = d.message.split(/\r?\n/)
  const message = firstLine === subject ? lines.join('\n').replace(/^[ \t]*\n/, '') : d.message
  const parents = d.parents.map((p, i) => h('span', null, i ? ', ' : '', h('button', { type: 'button', class: 'hash-link mono', title: p, onclick: () => host.select(p) }, shortHash(p))))
  const count = d.branches.length
  const separateCommitter = d.committer !== d.author || d.commitTime !== d.authorTime
  return h(
    'div',
    { class: 'cl-body' },
    message ? h('div', { class: 'cl-message' }, message) : null,
    h(
      'dl',
      { class: 'cl-metadata' },
      h('dt', null, t('colAuthor')),
      h(
        'dd',
        null,
        h('div', null, h('strong', null, d.author), ' ', h('span', { class: 'muted' }, `<${d.email}>`)),
        h('div', { class: 'muted' }, fullDate(d.authorTime))
      ),
      separateCommitter ? h('dt', null, t('detailsCommitter')) : null,
      separateCommitter ? h('dd', null, d.committer, h('div', { class: 'muted' }, fullDate(d.commitTime))) : null,
      parents.length ? h('dt', null, t('detailsParents', { count: parents.length })) : null,
      parents.length ? h('dd', null, ...parents) : null,
      h('dt', null, count ? t('detailsBranches', { count, n: count >= 50 ? `${count}+` : String(count) }) : t('sectionBranches')),
      h('dd', null, count ? d.branches.join(', ') : h('span', { class: 'muted' }, t('detailsNoBranches'))),
      h('dt', null, t('colHash')),
      h('dd', { class: 'mono' }, d.hash)
    )
  )
}

/**
 * One row per commit, in the order given; a click opens the full description under the row. Returns a reload: the open
 * rows load their details again and redraw only what changed, so scrolling and a text selection stay.
 */
export function renderCommitList(container: HTMLElement, commits: CommitRow[], host: CommitListHost): () => void {
  const reloads: (() => void)[] = []
  const rows = commits.map((commit) => {
    const chevron = h('span', { class: 'cl-chevron' })
    const title = h('span', { class: 'cl-subject' }, commit.subject || t('detailsUntitled'))
    const body = h('div', { class: 'cl-slot', id: `commit-details-${commit.hash}` })
    const head = h(
      'div',
      { class: 'cl-head', role: 'button', tabindex: 0, 'aria-controls': body.id },
      chevron,
      title,
      h('span', { class: 'cl-summary muted' }, h('span', { class: 'mono' }, shortHash(commit.hash)), commit.author)
    )
    let loaded = false
    /** The details drawn in the body, as JSON; the latest load wins. */
    let drawn = ''
    let loads = 0
    const show = () => {
      const open = host.expanded.has(commit.hash)
      head.setAttribute('aria-expanded', String(open))
      chevron.replaceChildren(icon(open ? 'chevronDown' : 'chevronRight'))
      body.hidden = !open
      if (!open || loaded) return
      loaded = true
      const mine = ++loads
      if (!drawn) body.replaceChildren(h('div', { class: 'cl-note', role: 'status' }, t('diffLoading')))
      host.load(commit.hash).then(
        (details) => {
          const json = JSON.stringify(details)
          if (mine !== loads || json === drawn) return
          drawn = json
          body.replaceChildren(renderBody(details, commit.subject, host))
        },
        (error) => {
          if (mine !== loads) return
          loaded = false
          drawn = ''
          body.replaceChildren(h('div', { class: 'cl-note' }, error instanceof Error ? error.message : String(error)))
        }
      )
    }
    reloads.push(() => {
      loaded = false
      show()
    })
    const toggle = () => {
      if (!host.expanded.delete(commit.hash)) host.expanded.add(commit.hash)
      show()
      host.onToggle()
    }
    head.addEventListener('click', (event) => {
      const selection = document.getSelection()
      if (title.contains(event.target as Node) && selection?.type === 'Range' && title.contains(selection.anchorNode)) return
      toggle()
    })
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const heads = Array.from(container.querySelectorAll<HTMLElement>('.cl-head'))
      // Past the first or last row the key scrolls as before, so a long open message stays readable.
      const next = heads[heads.indexOf(head) + (event.key === 'ArrowDown' ? 1 : -1)]
      if (!next) return
      next.focus()
      event.preventDefault()
    })
    show()
    return h('article', { class: 'cl-item' }, head, body)
  })
  container.replaceChildren(h('div', { class: 'cl-list' }, ...rows))
  return () => reloads.forEach((reload) => reload())
}
