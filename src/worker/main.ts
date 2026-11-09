import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { pickLocale, setLocale, t } from '../shared/i18n.ts'
import type { RepoResult, TabReveal } from '../shared/protocol.ts'
import { checkRewrite, runAction } from './actions.ts'
import { checkRebaseOnto, fetchAll, runBranchAction } from './branchActions.ts'
import { createGit, type Git } from './git.ts'
import { readDetails, readLogPage, readRefs } from './log.ts'
import { focusedWorkspace, resolveRepo, toplevel } from './repo.ts'
import { readFileDiff } from './diff.ts'
import { readRangeDiff, readSelectionFiles } from './selection.ts'
import { createPatch } from './patch.ts'
import { watchRepo, type RepoWatcher } from './watch.ts'

export const ANCHOR = '.orca-git-log.gitlog'

let orcaApi: OrcaWorkerApi
const repos = new Map<string, Git>()
const watchers = new Map<string, Promise<RepoWatcher | null>>()
/** Selections waiting for the Git tab of a repository to start and take them. */
const pending = new Map<string, TabReveal>()
const HASH = /^[0-9a-f]{40}$/

async function setting<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await orcaApi.settings.get(key)
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

const gitPath = () => setting('gitPath', 'git').then((path) => (typeof path === 'string' && path.trim()) || 'git')

/** A git runner for a root a panel sends back; only roots this worker resolved are accepted. */
async function gitFor(root: unknown): Promise<Git> {
  if (typeof root !== 'string' || !root) throw new Error(t('missingRepo'))
  const known = repos.get(root)
  if (known) return known
  const path = await gitPath()
  if (resolve(root) !== root || (await toplevel(root, path)) !== root) throw new Error(t('notGitRepo', { name: root }))
  const git = createGit(root, path)
  repos.set(root, git)
  return git
}

/** Adds `pattern` to the repository's info/exclude so the anchor never shows as untracked. */
async function exclude(git: Git, root: string, pattern: string): Promise<void> {
  const file = resolve(root, (await git.out(['rev-parse', '--git-path', 'info/exclude'])).trim())
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).includes(pattern)) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`)
}

function validReveal(r: any): r is TabReveal {
  return (
    Array.isArray(r?.hashes) &&
    r.hashes.length > 0 &&
    r.hashes.length <= 500 &&
    r.hashes.every((h: unknown) => typeof h === 'string' && HASH.test(h)) &&
    (r.path === undefined || typeof r.path === 'string')
  )
}

async function openTab(prefer?: string, reveal?: TabReveal): Promise<{ ok: boolean; reason?: string }> {
  if (Array.isArray(reveal?.hashes) && reveal.hashes.length > 500) return { ok: false, reason: t('selectionTooLarge') }
  if (reveal !== undefined && !validReveal(reveal)) return { ok: false, reason: t('invalidSelection') }
  const workspace = await focusedWorkspace(orcaApi, prefer)
  if ('reason' in workspace) return { ok: false, reason: workspace.reason }
  const path = await gitPath()
  const root = await toplevel(workspace.path, path)
  if (!root) return { ok: false, reason: t('workspaceNotRepo') }
  // Focus may have moved since the sidebar read its repository: its commits must not land in another one.
  if (reveal && reveal.root !== root) return { ok: false, reason: t('revealOtherRepo') }
  writeFileSync(join(workspace.path, ANCHOR), `${JSON.stringify({ root, workspaceId: workspace.id }, null, 2)}\n`)
  await exclude(createGit(root, path), root, ANCHOR)
  if (reveal) pending.set(root, { root, hashes: reveal.hashes, ...(reveal.path ? { path: reveal.path } : {}) })
  await orcaApi.host.call('editor.open', { workspaceId: workspace.id, path: ANCHOR })
  // An already open tab takes it from this event; a new one asks for it with tab.take.
  if (reveal) orcaApi.panels.post('tab.reveal', pending.get(root)!)
  return { ok: true }
}

export default function activate(orca: OrcaWorkerApi): void {
  orcaApi = orca

  // Each request names the caller's language; set it before the handler runs.
  const handle = (name: string, handler: (input: any) => unknown) =>
    orca.panels.handle(name, (input: any) => {
      setLocale(pickLocale(input?.locale))
      return handler(input)
    })

  handle('repo.resolve', async (input): Promise<RepoResult> => {
    const result = await resolveRepo(orca, await gitPath(), input?.root, input?.workspaceId)
    if (!result.ok) return result
    if (result.git) repos.set(result.repo.root, result.git)
    return { ok: true, repo: result.repo }
  })

  handle('repo.refs', async ({ root }) => readRefs(await gitFor(root)))

  handle('repo.watch', async ({ root }) => {
    const git = await gitFor(root)
    if (!watchers.has(root)) {
      watchers.set(
        root,
        watchRepo(git, root, () => orca.panels.post('repo.changed', { root })).catch(() => null)
      )
    }
    return { ok: (await watchers.get(root)) !== null }
  })

  handle('log.page', async ({ root, filter, skip, limit }) => {
    const pageSize = Number(limit ?? (await setting('pageSize', 300)))
    const size = Math.min(2000, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 300))
    return readLogPage(await gitFor(root), filter ?? {}, Math.max(0, Math.floor(Number(skip) || 0)), size)
  })

  handle('commit.details', async ({ root, hash }) => readDetails(await gitFor(root), hash))

  handle('file.diff', async ({ root, hash, path, oldPath, wholeFile }) =>
    readFileDiff(await gitFor(root), hash, path, oldPath, Boolean(wholeFile))
  )

  handle('selection.files', async ({ root, hashes }) => readSelectionFiles(await gitFor(root), hashes))

  handle('range.diff', async ({ root, from, to, path, oldPath, wholeFile }) =>
    readRangeDiff(await gitFor(root), from, to, path, oldPath, Boolean(wholeFile))
  )

  handle('patch.create', async ({ root, hashes, path, overwrite }) =>
    createPatch(await gitFor(root), root, hashes, path, Boolean(overwrite))
  )

  handle('action.check', async ({ root, kind, hashes }) => checkRewrite(await gitFor(root), kind, hashes))

  handle('action.run', async ({ root, action }) => {
    const result = await runAction(await gitFor(root), action)
    orca.panels.post('repo.changed', { root })
    return result
  })

  handle('branch.run', async ({ root, action }) => {
    const result = await runBranchAction(await gitFor(root), action)
    orca.panels.post('repo.changed', { root })
    return result
  })

  handle('branch.check', async ({ root, name }) => checkRebaseOnto(await gitFor(root), name))

  handle('repo.fetch', async ({ root }) => {
    const result = await fetchAll(await gitFor(root))
    if (result.ok) orca.panels.post('repo.changed', { root })
    return result
  })

  handle('tab.open', (input) => openTab(input?.workspaceId, input?.reveal))

  handle('tab.take', ({ root }) => {
    const reveal = pending.get(root) ?? null
    pending.delete(root)
    return reveal
  })

  orca.commands.register('open-tab', async () => {
    const result = await openTab()
    if (!result.ok) orca.log(`open-tab: ${result.reason}`)
    return result
  })
}

export function deactivate(): void {
  for (const watcher of watchers.values()) void watcher.then((w) => w?.close())
  watchers.clear()
}
