import { existsSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { RepoInfo, RepoResult, WorkspaceChoice } from '../shared/protocol.ts'
import { createGit, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'
import { operationInProgress } from './rebase.ts'

export interface Workspace {
  id: string
  path: string
}

export interface ListedWorkspace {
  id: string
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

interface Context {
  branch: string
  displayName: string
  terminals?: { id: string; title?: string }[]
}

export type Match = { workspace: ListedWorkspace } | { remote: true } | { ambiguous: ListedWorkspace[] } | null

const shortBranch = (branch: string | null | undefined) => (branch ?? '').replace(/^refs\/heads\//, '')
const slashes = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const isLocal = (w: ListedWorkspace) => (!w.hostId || w.hostId === 'local') && existsSync(w.path)

/** True when `text` names `path` (Windows or MSYS spelling), not just a longer sibling path. */
function mentions(text: string, path: string): boolean {
  const forms = [path]
  const drive = /^([a-z]):(\/.*)?$/.exec(path)
  if (drive) forms.push(`/${drive[1]}${drive[2] ?? ''}`)
  for (const form of forms) {
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
      if (!/[\w.-]/.test(text[at + form.length] ?? '')) return true
    }
  }
  return false
}

/**
 * Picks the listed workspace that `workspace.readContext` describes. The context carries no id or
 * path, so same-named workspaces are told apart by branch, then by the paths their terminal titles
 * show (shells usually print their cwd there), then by `prefer` (a previous choice).
 */
export function matchWorkspace(context: Context, workspaces: ListedWorkspace[], prefer?: string | null): Match {
  const named = workspaces.filter((w) => w.name === context.displayName)
  let pool = named.length ? named : workspaces.filter((w) => basename(w.path) === context.displayName)
  const sameBranch = pool.filter((w) => shortBranch(w.branch) === shortBranch(context.branch))
  if (sameBranch.length) pool = sameBranch
  const local = pool.filter(isLocal)
  if (!local.length) return pool.length ? { remote: true } : null
  if (local.length === 1) return { workspace: local[0] }

  const titles = (context.terminals ?? []).map((t) => slashes(t.title ?? '')).filter(Boolean)
  const shown = local.filter((w) => titles.some((title) => mentions(title, slashes(w.path))))
  if (shown.length === 1) return { workspace: shown[0] }
  const preferred = local.find((w) => w.id === prefer)
  if (preferred) return { workspace: preferred }
  return { ambiguous: shown.length ? shown : local }
}

let lastChoice: string | null = null

export async function focusedWorkspace(
  orca: OrcaWorkerApi,
  prefer?: string | null
): Promise<Workspace | { reason: string; choices?: WorkspaceChoice[] }> {
  const context = (await orca.host.call('workspace.readContext', {})) as Context | null
  if (!context) return { reason: t('openWorkspace') }
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
  const match = matchWorkspace(context, workspaces, prefer ?? lastChoice)
  if (!match) return { reason: t('workspaceNotFound', { name: context.displayName }) }
  if ('remote' in match) return { reason: t('remoteUnsupported') }
  if ('ambiguous' in match) {
    return {
      reason: t('workspacesAmbiguous', { name: context.displayName }),
      choices: match.ambiguous.map(({ id, name, path, branch }) => ({ id, name, path, branch: shortBranch(branch) }))
    }
  }
  lastChoice = match.workspace.id
  return { id: match.workspace.id, path: match.workspace.path }
}

export async function toplevel(path: string, gitPath: string): Promise<string | null> {
  const result = await createGit(path, gitPath).run(['rev-parse', '--show-toplevel'])
  return result.ok ? resolve(result.stdout.trim()) : null
}

export async function describeRepo(git: Git, root: string, workspaceId: string | null): Promise<RepoInfo> {
  const [head, operation] = await Promise.all([readHead(git), operationInProgress(git)])
  return { root, name: basename(root), workspaceId, head, operation }
}

export async function resolveRepo(
  orca: OrcaWorkerApi,
  gitPath: string,
  requested?: string,
  prefer?: string
): Promise<RepoResult & { git?: Git }> {
  let path: string
  let workspaceId: string | null = null
  if (requested) {
    if (!isAbsolute(requested) || !existsSync(requested)) return { ok: false, reason: t('pathGone', { path: requested }) }
    path = requested
  } else {
    const workspace = await focusedWorkspace(orca, prefer)
    if ('reason' in workspace) return { ok: false, ...workspace }
    path = workspace.path
    workspaceId = workspace.id
  }
  const root = await toplevel(path, gitPath)
  if (!root) return { ok: false, reason: t('notGitRepo', { name: basename(path) }) }
  const git = createGit(root, gitPath)
  return { ok: true, repo: await describeRepo(git, root, workspaceId), git }
}
