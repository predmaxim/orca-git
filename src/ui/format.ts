import { getLocale, t, type MessageKey } from '../shared/i18n.ts'
import type { BranchRef, CommitRow } from '../shared/protocol.ts'

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** Log dates: "Moments ago", "5 minutes ago", "Today 14:02", "Yesterday 09:12", then the date. */
export function relativeDate(seconds: number, now = Date.now()): string {
  const date = new Date(seconds * 1000)
  const diff = Math.max(0, now - date.getTime())
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t('dateMomentsAgo')
  const ago = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always' })
  if (minutes < 60) return ago.format(-minutes, 'minute')
  if (minutes < 120) return ago.format(-1, 'hour')
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  if (date >= today) return t('dateToday', { time: hhmm(date) })
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date >= yesterday) return t('dateYesterday', { time: hhmm(date) })
  return `${date.toLocaleDateString(getLocale(), { year: 'numeric', month: 'numeric', day: 'numeric' })}, ${hhmm(date)}`
}

export function fullDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

export interface RefLabel {
  kind: 'head' | 'local' | 'remote' | 'tag'
  text: string
  /** The checked-out branch. */
  current?: boolean
  /** Ref names this label stands for, for "Checkout" and filters. */
  refs: string[]
}

/**
 * Turns a commit's full ref names into compact labels: a local branch and its remote
 * counterparts on the same commit merge into "origin & main".
 */
export function refLabels(refs: string[], currentBranch: string | null): RefLabel[] {
  const locals: string[] = []
  const remotes: string[] = []
  const tags: string[] = []
  let detached = false
  for (const ref of refs) {
    if (ref === 'HEAD') detached = true
    else if (ref.startsWith('refs/heads/')) locals.push(ref.slice(11))
    else if (ref.startsWith('refs/remotes/')) remotes.push(ref.slice(13))
    else if (ref.startsWith('refs/tags/')) tags.push(ref.slice(10))
  }
  const labels: RefLabel[] = []
  if (detached) labels.push({ kind: 'head', text: 'HEAD', refs: ['HEAD'] })
  const usedRemotes = new Set<string>()
  const sortedLocals = locals.sort((a, b) => Number(b === currentBranch) - Number(a === currentBranch) || a.localeCompare(b))
  for (const name of sortedLocals) {
    const matching = remotes.filter((r) => r.slice(r.indexOf('/') + 1) === name)
    matching.forEach((r) => usedRemotes.add(r))
    const prefix = matching.map((r) => r.slice(0, r.indexOf('/'))).join(' & ')
    labels.push({
      kind: 'local',
      text: prefix ? `${prefix} & ${name}` : name,
      current: name === currentBranch,
      refs: [name, ...matching]
    })
  }
  for (const name of remotes.sort()) if (!usedRemotes.has(name)) labels.push({ kind: 'remote', text: name, refs: [name] })
  for (const name of tags.sort()) labels.push({ kind: 'tag', text: name, refs: [name] })
  return labels
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

/** Commits reachable from `head` among the loaded rows (the rest are greyed out). */
export function reachableFrom(head: string | null, rows: CommitRow[]): Set<string> {
  const reachable = new Set<string>()
  if (!head) return reachable
  const byHash = new Map(rows.map((row) => [row.hash, row]))
  const stack = [head]
  while (stack.length) {
    const hash = stack.pop()!
    if (reachable.has(hash)) continue
    const row = byHash.get(hash)
    if (!row) continue
    reachable.add(hash)
    stack.push(...row.parents)
  }
  return reachable
}

/** Remote branches grouped by remote name, for the branches tree. */
export function groupRemotes(remotes: BranchRef[]): Map<string, BranchRef[]> {
  const groups = new Map<string, BranchRef[]>()
  for (const ref of remotes) {
    const remote = ref.name.slice(0, ref.name.indexOf('/')) || ref.name
    groups.set(remote, [...(groups.get(remote) ?? []), ref])
  }
  return groups
}

export type BranchNode =
  | { kind: 'folder'; name: string; path: string; children: BranchNode[] }
  | { kind: 'branch'; label: string; ref: BranchRef }

/** Branches nested into folders by their `/` prefixes: folders first, then branches, each sorted by name. `strip` removes a leading prefix (the remote name). */
export function groupByPrefix(refs: BranchRef[], strip = ''): BranchNode[] {
  const root: BranchNode[] = []
  for (const ref of refs) {
    const name = strip && ref.name.startsWith(`${strip}/`) ? ref.name.slice(strip.length + 1) : ref.name
    const parts = name.split('/')
    let level = root
    parts.slice(0, -1).forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      let folder = level.find((n) => n.kind === 'folder' && n.name === part)
      if (!folder) level.push((folder = { kind: 'folder', name: part, path, children: [] }))
      level = (folder as Extract<BranchNode, { kind: 'folder' }>).children
    })
    level.push({ kind: 'branch', label: parts[parts.length - 1], ref })
  }
  const sort = (nodes: BranchNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || nodeName(a).localeCompare(nodeName(b)))
    for (const n of nodes) if (n.kind === 'folder') sort(n.children)
  }
  sort(root)
  return root
}

const nodeName = (n: BranchNode) => (n.kind === 'folder' ? n.name : n.label)

/** The name of a `git diff --name-status` letter, if it is one Git Log knows. */
export const statusName = (letter: string): string | undefined => (/^[AMDRCTU]$/.test(letter) ? t(`status${letter}` as MessageKey) : undefined)
