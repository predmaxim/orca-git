import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { pickLocale, setLocale, t } from '../shared/i18n.ts'
import type { DiffTabState, RepoResult } from '../shared/protocol.ts'
import { checkRewrite, runAction } from './actions.ts'
import { checkBackup, checkReset, deleteBackup, runGuarded } from './backup.ts'
import { checkRebaseOnto, fetchAll, runBranchAction } from './branchActions.ts'
import { DIFF_ANCHOR, validDiffState, workspaceFor } from './diffTab.ts'
import { createGit, type Git } from './git.ts'
import { readDetails, readLogPage, readRefs } from './log.ts'
import { resolveRepo, toplevel } from './repo.ts'
import { readFileDiff } from './diff.ts'
import { readRangeDiff, readSelectionFiles } from './selection.ts'
import { createPatch } from './patch.ts'
import { watchRepo, type RepoWatcher } from './watch.ts'

let orcaApi: OrcaWorkerApi
const repos = new Map<string, Git>()
const watchers = new Map<string, Promise<RepoWatcher | null>>()
/** What each repository's Diff tab shows; the tab reads it when it starts and on `diff.show`. */
const diffStates = new Map<string, DiffTabState>()

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

const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants

/** Whether `anchor` is the file this plugin wrote for `root`. Never follows a link or waits on a FIFO. */
function isOurAnchor(anchor: string, root: string): boolean {
  let fd: number
  try {
    fd = openSync(anchor, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return false
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) return false
    const bytes = new Uint8Array(stat.size)
    const read = readSync(fd, bytes, 0, bytes.length, 0)
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, read)))?.root === root
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Creates the Diff tab's anchor, or accepts the one this plugin already wrote for `root` as it is.
 * Otherwise returns why not; anything else under that name is left alone.
 */
function claimAnchor(anchor: string, root: string, text: string): string | null {
  let fd: number
  try {
    // wx never follows a symlink, even a dangling one, and never replaces a file.
    fd = openSync(anchor, 'wx')
  } catch (error: any) {
    if (error?.code === 'EEXIST') return isOurAnchor(anchor, root) ? null : t('diffAnchorTaken', { path: anchor })
    return t('diffAnchorFailed', { path: anchor, code: error?.code ?? String(error) })
  }
  let failure: any = null
  try {
    writeFileSync(fd, text)
  } catch (error) {
    failure = error
  } finally {
    closeSync(fd)
  }
  if (!failure) return null
  // Only the file this call created: a half-written one would be refused as not ours on every later click.
  try {
    unlinkSync(anchor)
  } catch {
    // Already gone.
  }
  return t('diffAnchorFailed', { path: anchor, code: failure?.code ?? String(failure) })
}

async function openDiff(input: any): Promise<{ ok: boolean; reason?: string }> {
  if (!validDiffState(input)) return { ok: false, reason: t('diffInvalid') }
  const git = await gitFor(input.root)
  const root: string = input.root
  const workspace = await workspaceFor(orcaApi, root, await gitPath())
  if (!workspace) return { ok: false, reason: t('diffNoWorkspace') }
  const anchor = join(workspace.path, DIFF_ANCHOR)
  const refused = claimAnchor(anchor, root, `${JSON.stringify({ root, workspaceId: workspace.id }, null, 2)}\n`)
  if (refused) return { ok: false, reason: refused }
  await exclude(git, root, DIFF_ANCHOR)
  diffStates.set(root, { root, files: input.files, index: input.index })
  await orcaApi.host.call('editor.open', { workspaceId: workspace.id, path: DIFF_ANCHOR })
  // An open tab reads the new state on this event; a new one reads it when it starts.
  orcaApi.panels.post('diff.show', { root })
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

  handle('action.run', async ({ root, action, expectHead, backup }) => {
    const git = await gitFor(root)
    const hardReset = action?.kind === 'reset' && action?.mode === 'hard'
    const result = await runGuarded(git, { expectHead, backup }, 'HEAD', () => runAction(git, action), hardReset)
    orca.panels.post('repo.changed', { root })
    return result
  })

  handle('branch.run', async ({ root, action, expectHead, backup }) => {
    const git = await gitFor(root)
    // A deleted branch's backup keeps that branch; every other branch action moves HEAD.
    const tip = action?.kind === 'delete' ? { branch: action.name } : 'HEAD'
    const result = await runGuarded(git, { expectHead, backup }, tip, () => runBranchAction(git, action))
    orca.panels.post('repo.changed', { root })
    return result
  })

  handle('backup.check', async ({ root, kind, name }) => checkBackup(await gitFor(root), kind, name))

  handle('reset.check', async ({ root, target }) => checkReset(await gitFor(root), root, target))

  handle('backup.delete', async ({ root, action }) => {
    const result = await deleteBackup(await gitFor(root), action)
    orca.panels.post('repo.changed', { root })
    return result
  })

  handle('branch.check', async ({ root, name }) => checkRebaseOnto(await gitFor(root), name))

  handle('repo.fetch', async ({ root }) => {
    const result = await fetchAll(await gitFor(root))
    if (result.ok) orca.panels.post('repo.changed', { root })
    return result
  })

  handle('diff.open', openDiff)

  handle('diff.state', ({ root }) => diffStates.get(root) ?? null)

  handle('diff.index', ({ root, index }) => {
    const state = diffStates.get(root)
    if (!state || !Number.isInteger(index) || index < 0 || index >= state.files.length) return { ok: false }
    diffStates.set(root, { ...state, index })
    orca.panels.post('diff.current', { root, path: state.files[index].path })
    return { ok: true }
  })
}

export function deactivate(): void {
  for (const watcher of watchers.values()) void watcher.then((w) => w?.close())
  watchers.clear()
}
