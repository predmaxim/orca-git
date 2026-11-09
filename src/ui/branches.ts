import type { BranchRef, RefsResult } from '../shared/protocol.ts'
import { h, icon } from './dom.ts'
import { t } from '../shared/i18n.ts'
import { groupByPrefix, groupRemotes, type BranchNode } from './format.ts'

export interface BranchesHost {
  refs: RefsResult | null
  /** Full ref names the log is filtered to. */
  filtered: string[]
  collapsed: Set<string>
  onCollapse(): void
  /** Double click: select the commit in the log. */
  select(hash: string): void
  /** Single click: show only this ref. */
  filterTo(full: string): void
  menu(event: MouseEvent, ref: BranchRef & { kind: 'local' | 'remote' | 'tag' | 'head' }): void
}

export function renderBranches(container: HTMLElement, host: BranchesHost, query: string): void {
  const refs = host.refs
  if (!refs) {
    container.replaceChildren()
    return
  }
  const q = query.trim().toLowerCase()
  const rows: HTMLElement[] = []
  const matches = (name: string) => !q || name.toLowerCase().includes(q)

  const group = (id: string, label: string, depth: number, count: number) => {
    const open = q !== '' || !host.collapsed.has(id)
    rows.push(
      h(
        'div',
        {
          class: 'node-row group',
          style: `padding-left:${4 + depth * 14}px`,
          onclick: () => {
            if (host.collapsed.has(id)) host.collapsed.delete(id)
            else host.collapsed.add(id)
            host.onCollapse()
          }
        },
        h('span', { class: 'twisty' }, icon(open ? 'chevronDown' : 'chevronRight')),
        h('span', { class: 'label' }, label),
        h('span', { class: 'count' }, String(count))
      )
    )
    return open
  }

  const leaf = (ref: BranchRef, kind: 'local' | 'remote' | 'tag' | 'head', label: string, depth: number, current = false) => {
    const filtered = host.filtered.includes(ref.full)
    rows.push(
      h(
        'div',
        {
          class: `node-row${filtered ? ' filtered' : ''}`,
          style: `padding-left:${4 + depth * 14 + 16}px`,
          title: `${ref.full}${ref.upstream ? `\nTracking ${ref.upstream}` : ''}\n${t('branchRowTip', { kind: t(kind === 'tag' ? 'kindTag' : 'kindBranch') })}`,
          // The second click of a double click does nothing: filterTo toggles and would undo the first.
          onclick: (event: MouseEvent) => event.detail <= 1 && host.filterTo(ref.full),
          ondblclick: () => ref.hash && host.select(ref.hash),
          oncontextmenu: (event: MouseEvent) => {
            event.preventDefault()
            host.menu(event, { ...ref, kind })
          }
        },
        current ? icon('star', 'ic-head') : icon(kind === 'tag' ? 'tag' : 'branch', `ic-${kind}`),
        h('span', { class: 'label' }, label),
        ref.upstream && kind === 'local' ? h('span', { class: 'track' }, `→ ${ref.upstream.replace(/^refs\/remotes\//, '')}`) : null
      )
    )
  }

  if (refs.head.hash && matches('HEAD')) {
    leaf({ name: 'HEAD', full: 'HEAD', hash: refs.head.hash }, 'head', 'HEAD (Current Branch)', 0, true)
  }

  // Folders keep their open state in `collapsed` under `<scope>:<path>`.
  const tree = (nodes: BranchNode[], scope: string, kind: 'local' | 'remote', depth: number): void => {
    for (const node of nodes) {
      if (node.kind === 'branch') {
        leaf(node.ref, kind, node.label, depth, kind === 'local' && node.ref.name === refs.head.branch)
        continue
      }
      const count = (n: BranchNode): number => (n.kind === 'branch' ? 1 : n.children.reduce((sum, c) => sum + count(c), 0))
      if (group(`${scope}:${node.path}`, node.name, depth, count(node))) tree(node.children, scope, kind, depth + 1)
    }
  }

  const locals = refs.locals.filter((r) => matches(r.name))
  if (locals.length && group('local', 'Local', 0, locals.length)) {
    tree(groupByPrefix(locals), 'local', 'local', 1)
  }

  const remotes = refs.remotes.filter((r) => matches(r.name))
  if (remotes.length && group('remote', 'Remote', 0, remotes.length)) {
    for (const [remote, list] of groupRemotes(remotes)) {
      if (group(`remote/${remote}`, remote, 1, list.length)) {
        tree(groupByPrefix(list, remote), `remote/${remote}`, 'remote', 2)
      }
    }
  }

  const tags = refs.tags.filter((r) => matches(r.name))
  if (tags.length && group('tags', 'Tags', 0, tags.length)) {
    for (const ref of tags) leaf(ref, 'tag', ref.name, 1)
  }

  container.replaceChildren(...rows)
}
