import { resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { DiffTabState } from '../shared/protocol.ts'
import { isLocal, toplevel, type ListedWorkspace } from './repo.ts'

/** The file the Diff tab is opened on: Orca shows the plugin's custom editor for its extension. */
export const DIFF_ANCHOR = '.orca-git-log.gitdiff'

const HASH = /^[0-9a-f]{40}$/
const isHash = (value: unknown) => typeof value === 'string' && HASH.test(value)
const isPath = (value: unknown) => typeof value === 'string' && value !== '' && !value.includes('\0')

/** Whether `state` lists selection files the Diff tab can show; the caller checks its root. */
export function validDiffState(state: any): state is DiffTabState {
  const files = state?.files
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.length <= 2000 &&
    files.every(
      (file: any) =>
        typeof file?.status === 'string' &&
        /^[AMDRCT]$/.test(file.status) &&
        isPath(file.path) &&
        (file.oldPath === undefined || isPath(file.oldPath)) &&
        (file.from === null || isHash(file.from)) &&
        isHash(file.to)
    ) &&
    Number.isInteger(state.index) &&
    state.index >= 0 &&
    state.index < files.length
  )
}

/** The local workspace whose repository top level is `root`, or null when no workspace holds it. */
export async function workspaceFor(orca: OrcaWorkerApi, root: string, gitPath: string): Promise<ListedWorkspace | null> {
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
  // A workspace at the root itself is the usual case: checking it first saves a git process per other workspace.
  const atRoot = (workspace: ListedWorkspace) => Number(resolve(workspace.path) === root)
  for (const workspace of workspaces.filter(isLocal).sort((a, b) => atRoot(b) - atRoot(a))) {
    if ((await toplevel(workspace.path, gitPath)) === root) return workspace
  }
  return null
}
