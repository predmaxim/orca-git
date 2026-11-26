// The log and the Diff tab use the absolute git worktree root. Linked worktrees have distinct roots.
import type { LogFilter } from '../shared/protocol.ts'

export interface PanelView {
  filter: LogFilter
  hashes: string[]
  cursor: string | null
  anchor: string | null
  /** Number of rows through the deepest selected commit, to get back to it in larger pages. */
  depth: number
  file: string | null
}

const key = (root: string) => 'git-log.view.' + root
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && s.length > 0) : []

export function readView(root: string): PanelView | null {
  try {
    const view = JSON.parse(localStorage.getItem(key(root)) ?? 'null')
    if (!view || !Array.isArray(view.hashes) || !view.filter || typeof view.filter !== 'object' || Array.isArray(view.filter)) return null
    const filter: LogFilter = {}
    for (const name of ['branches', 'users', 'paths'] as const) {
      const values = strings(view.filter[name])
      if (values.length) filter[name] = values
    }
    if (typeof view.filter.text === 'string') filter.text = view.filter.text
    if (Number.isFinite(view.filter.since)) filter.since = view.filter.since
    if (Number.isFinite(view.filter.until)) filter.until = view.filter.until
    return {
      filter,
      hashes: [...new Set<string>(view.hashes.filter(hash))],
      cursor: hash(view.cursor) ? view.cursor : null,
      anchor: hash(view.anchor) ? view.anchor : null,
      depth: Number.isSafeInteger(view.depth) && view.depth > 0 ? view.depth : 0,
      file: typeof view.file === 'string' ? view.file : null
    }
  } catch {
    return null
  }
}

export function writeView(root: string, view: PanelView): void {
  try {
    localStorage.setItem(key(root), JSON.stringify(view))
  } catch {
    // The panel still works in memory if the browser refuses storage.
  }
}
