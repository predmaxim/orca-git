import type { OrcaWorkerApi } from 'orca/worker'
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
