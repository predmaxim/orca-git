import type { OrcaWorkerApi } from 'orca/worker'
import type { SelectionFile } from '../shared/protocol.ts'
import { isLocal, toplevel, type ListedWorkspace } from './repo.ts'

/** The file the Diff tab is opened on: Orca shows the plugin's custom editor for its extension. */
export const DIFF_ANCHOR = '.orca-git-log.gitdiff'

/** The local workspace whose repository top level is `root`, or null when no workspace holds it. */
export async function workspaceFor(orca: OrcaWorkerApi, root: string, gitPath: string): Promise<ListedWorkspace | null> {
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
  // A workspace at the root itself is the usual case: checking it first saves a git process per other workspace.
  const atRoot = (workspace: ListedWorkspace) => Number(workspace.path.replace(/[\\/]+$/, '') === root)
  for (const workspace of workspaces.filter(isLocal).sort((a, b) => atRoot(b) - atRoot(a))) {
    if ((await toplevel(workspace.path, gitPath)) === root) return workspace
  }
  return null
}

/**
 * The files the Diff tab gets around the one at `index`: Orca refuses a worker's answer over 1 MiB, so they are taken one after
 * and one before in turn while their JSON (UTF-8, a comma each) fits in `limit` bytes. The file at `index` is always there.
 */
export function fitWindow(files: SelectionFile[], index: number, limit = 900_000): { first: number; count: number } {
  const bytes = (i: number) => new TextEncoder().encode(JSON.stringify(files[i])).length + 1
  let first = index
  let end = index + 1
  let total = bytes(index)
  let after = end < files.length
  let before = first > 0
  while (after || before) {
    if (after) {
      const size = bytes(end)
      if (total + size <= limit) {
        total += size
        after = ++end < files.length
      } else after = false
    }
    if (before) {
      const size = bytes(first - 1)
      if (total + size <= limit) {
        total += size
        before = --first > 0
      } else before = false
    }
  }
  return { first, count: end - first }
}
