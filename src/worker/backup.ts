import { lstatSync, readdirSync } from 'node:fs'
import type { ActionResult, BackupDelete, ResetCheck } from '../shared/protocol.ts'
import { assertName } from './actions.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'

const HASH = /^[0-9a-f]{40}$/

type Made = { ok: true; name: string; stash?: string }
/** `name`: the backup ref that was made before the step that failed. */
type Refused = { ok: false; message: string; name?: string }

const refused = (error: unknown): Refused => ({ ok: false, message: error instanceof Error ? error.message : String(error) })

const refName = (kind: 'branch' | 'tag', name: string) => `${kind === 'branch' ? 'refs/heads' : 'refs/tags'}/${name}`

/** The commit `ref` (a full ref name) points at, or null when there is no such ref. */
async function tipOf(git: Git, ref: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`])
  return result.ok ? result.stdout.trim() : null
}

/** Longest backup name, in UTF-8 bytes: loose refs are files, and a file name is at most 255 bytes. */
const NAME_MAX = 200

/**
 * `name` trimmed, once it can become a new backup `kind`: a name git accepts, not under `refs/`, not taken,
 * and not a folder of an existing ref or under one (git keeps refs as files). Throws the reason otherwise.
 */
async function backupName(git: Git, kind: unknown, name: unknown): Promise<string> {
  if ((kind !== 'branch' && kind !== 'tag') || typeof name !== 'string') throw new Error(t('backupInvalid'))
  const checked = await assertName(git, name, kind)
  if (checked.startsWith('refs/')) throw new Error(t('backupNameRefs'))
  if (new TextEncoder().encode(checked).length > NAME_MAX) throw new Error(t('backupNameLong', { max: NAME_MAX }))
  const full = refName(kind, checked)
  const parents = checked.split('/').slice(0, -1).map((_, i, parts) => refName(kind, parts.slice(0, i + 1).join('/')))
  // A pattern lists the ref and every ref under it; only the exact parents and the name's own subtree clash.
  const listed = (await git.out(['for-each-ref', '--format=%(refname)', full, ...parents])).split('\n')
  const clash = listed.find((ref) => ref === full || ref.startsWith(`${full}/`) || parents.includes(ref))
  if (clash === full) throw new Error(t('backupExists', { name: checked }))
  if (clash) throw new Error(t('backupNameClash', { name: checked, ref: clash.replace(/^refs\/(heads|tags)\//, '') }))
  return checked
}

/** Whether `name` can become a new backup `kind`, for the dialog to say before it closes. Never throws. */
export async function checkBackup(git: Git, kind: unknown, name: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await backupName(git, kind, name)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: refused(error).message }
  }
}

/** Characters of pathspecs per git call: Windows caps a whole command line at 32,767. */
const PATHSPECS_MAX = 8000

/** What `ls-files -o` with `options` finds at `paths`, ignored files included, in calls of at most PATHSPECS_MAX characters. */
async function untrackedAt(git: Git, options: string[], paths: string[]): Promise<string[]> {
  const found: string[] = []
  let batch: string[] = []
  let size = 0
  const flush = async () => {
    if (batch.length) found.push(...(await git.out(['ls-files', '-z', '-o', ...options, '--', ...batch])).split('\0').filter(Boolean))
    batch = []
    size = 0
  }
  for (const path of paths) {
    const spec = `:(literal)${path}`
    if (batch.length && size + spec.length > PATHSPECS_MAX) await flush()
    batch.push(spec)
    size += spec.length + 1
  }
  await flush()
  return found
}

/** Whether anything, a dangling link included, is at `path`. */
const present = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** What is at `path`, a link counted as a file and never followed; a nested repository is a real folder holding `.git`. */
function foundAt(path: string): 'nothing' | 'file' | 'folder' | 'repository' {
  try {
    if (!lstatSync(path).isDirectory()) return 'file'
  } catch {
    return 'nothing'
  }
  return present(`${path}/.git`) ? 'repository' : 'folder'
}

/**
 * What the reset overwrites at the paths in `added` past a nested repository, where git's listing does
 * not look but a hard reset writes through: a file or link standing where a folder is needed, or
 * anything at the path itself. Each folder is checked with `lstat`, so no link is followed.
 */
function insideNestedRepos(root: string, added: string[]): string[] {
  const seen = new Map<string, ReturnType<typeof foundAt>>()
  const at = (path: string) => {
    if (!seen.has(path)) seen.set(path, foundAt(`${root}/${path}`))
    return seen.get(path)
  }
  const listed = new Set<string>()
  for (const path of added) {
    const parts = path.split('/')
    let inside = false
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      const state = at(prefix)
      if (state === 'nothing') break
      // Before the nested repository git's own listing covers it.
      if (!inside) {
        if (state === 'file') break
        inside = state === 'repository'
      } else if (state === 'file' || i === parts.length) {
        listed.add(prefix)
        break
      }
    }
  }
  return [...listed]
}

/** Most folder entries the repository search reads in one check, so a deleted `node_modules` cannot stall the dialog. */
const SEARCH_MAX = 10_000

/** Whether `path` is a real folder reached through real folders only: a hard reset never writes through a link. */
function realFolder(root: string, path: string): boolean {
  const parts = path.split('/')
  try {
    return lstatSync(`${root}/${path}`).isDirectory() && parts.every((_, i) => lstatSync(`${root}/${parts.slice(0, i + 1).join('/')}`).isDirectory())
  } catch {
    return false
  }
}

/** The entries of `folder`, links not followed; null when it cannot be read. */
function entriesOf(folder: string): { name: string; isDirectory(): boolean }[] | null {
  try {
    return readdirSync(folder, { withFileTypes: true })
  } catch {
    return null
  }
}

/**
 * The repositories at or under `path`, a folder the reset deletes, as `name/`: a folder holding `.git` (a
 * folder or a file) is one, and the search goes neither into it nor through links. It reads at most
 * `budget.left` entries; `complete` is false when it runs out or a folder cannot be read.
 */
function repositoriesIn(root: string, path: string, budget: { left: number }): { found: string[]; complete: boolean } {
  const found: string[] = []
  const folders = [path]
  while (folders.length) {
    const folder = folders.pop()!
    const entries = entriesOf(`${root}/${folder}`)
    if (!entries || (budget.left -= entries.length) < 0) return { found, complete: false }
    if (entries.some((entry) => entry.name === '.git')) found.push(`${folder}/`)
    else folders.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => `${folder}/${entry.name}`))
  }
  return { found, complete: true }
}

/**
 * What a hard reset to `target` would lose: whether tracked files have uncommitted changes; the untracked
 * files, ignored ones included, it overwrites: those at a path the target has and the index or the work
 * tree lacks (or inside a folder there, or inside a nested repository), and those standing where `target`
 * needs a folder; and, as `name/`, every repository inside a folder it replaces with a file, at any depth,
 * which it deletes whole. `unchecked`: such folders too large or unreadable to search completely. A folder
 * where the target has a submodule is kept. `root` is the repository's top level.
 */
export async function checkReset(git: Git, root: string, target: unknown): Promise<ResetCheck> {
  if (typeof target !== 'string' || !HASH.test(target)) throw new Error(t('invalidCommit'))
  const dirty = (await git.out(['status', '--porcelain', '-z', '--untracked-files=no'])) !== ''
  // The target against the index and work tree, so no commit is needed on HEAD: D and T are the paths the
  // reset writes, with something else there or nothing. --ignore-submodules=none: config must not hide submodules.
  const fields = (await git.out(['diff', '-z', '--raw', '--no-renames', '--ignore-submodules=none', '--diff-filter=DT', target, '--'])).split('\0')
  const paths: string[] = []
  const submodules = new Set<string>()
  for (let i = 1; i < fields.length; i += 2) {
    paths.push(fields[i])
    if (fields[i - 1].startsWith(':160000 ')) submodules.add(fields[i])
  }
  const folders = new Set(paths.flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))
  // --directory lists an untracked folder as one `name/` line, so only a file named like a folder matches it.
  const blocking = (await untrackedAt(git, ['--directory'], [...folders])).filter((path) => folders.has(path))
  // At a submodule the reset keeps any folder, so only a file or link there is overwritten.
  const kept = (path: string) => {
    const bare = path.replace(/\/$/, '')
    return submodules.has(bare) ? realFolder(root, bare) : [...submodules].some((submodule) => bare.startsWith(`${submodule}/`))
  }
  const found = [...new Set([...(await untrackedAt(git, [], paths)), ...blocking, ...insideNestedRepos(root, paths)])].filter((path) => !kept(path)).sort()
  // Git lists a nested repository as `name/`; the walk lists one without the slash.
  const isRepository = (path: string) => foundAt(`${root}/${path.replace(/\/$/, '')}`) === 'repository'
  const repositories = new Set(found.filter(isRepository).map((path) => path.replace(/\/?$/, '/')))
  const budget = { left: SEARCH_MAX }
  const unchecked: string[] = []
  for (const path of paths) {
    if (submodules.has(path) || !realFolder(root, path)) continue
    const { found: inside, complete } = repositoriesIn(root, path, budget)
    inside.forEach((repository) => repositories.add(repository))
    if (!complete) unchecked.push(path)
  }
  const listed = [...repositories].sort()
  return {
    dirty,
    // A path inside a listed repository goes with it.
    overwritten: found.filter((path) => !isRepository(path) && !listed.some((repository) => path.startsWith(repository))),
    repositories: listed,
    ...(unchecked.length ? { unchecked } : {})
  }
}

/**
 * Creates the backup branch or tag `name` at `target`, never moving an existing ref; with `stash`, first
 * snapshots the uncommitted changes into the stash without touching the work tree. Never throws.
 */
export async function createBackup(git: Git, request: unknown): Promise<Made | Refused> {
  try {
    const { kind, name, target, stash } = (request ?? {}) as Record<string, unknown>
    if (typeof target !== 'string' || !HASH.test(target)) throw new Error(t('backupInvalid'))
    const checked = await backupName(git, kind, name)
    // stash create writes only objects; the stash ref changes after the backup ref exists.
    const snapshot = stash === true ? (await git.out(['stash', 'create'])).trim() : ''
    await git.out(kind === 'branch' ? ['branch', '--no-track', checked, target] : ['tag', checked, target])
    if (!snapshot) return { ok: true, name: checked }
    const branch = (await readHead(git)).branch ?? 'HEAD'
    const stored = await git.run(['stash', 'store', '-m', `Git plugin backup before reset --hard (${branch})`, snapshot])
    if (!stored.ok) return { ok: false, name: checked, message: `${t('backupStashFailed', { name: checked })}\n${lastLines(stored.stderr || stored.stdout, 3)}` }
    return { ok: true, name: checked, stash: snapshot }
  } catch (error) {
    return refused(error)
  }
}

/** What `action.run` and `branch.run` take besides the action, as a frame sent it. */
export interface Guard {
  /** The HEAD the confirmation showed; the action runs only while HEAD is still there. */
  expectHead?: unknown
  backup?: unknown
}

/**
 * Runs `run` only while HEAD is still `expectHead` and after the backup, when one is asked for, is made.
 * The backup must point at `tip`: HEAD, or the branch an action deletes. A failed action still reports
 * the backup it left; one that ran reports the HEAD it left, for Undo to expect. A stash is taken only
 * for a hard reset (`hardReset`), the one action that throws uncommitted changes away.
 */
export async function runGuarded<R extends ActionResult>(
  git: Git,
  guard: Guard,
  tip: 'HEAD' | { branch: string },
  run: () => Promise<R>,
  hardReset = false
): Promise<R | ActionResult> {
  const { expectHead, backup } = guard
  if (expectHead === undefined && backup === undefined) return run()
  let made: Made | undefined
  try {
    const head = (await readHead(git)).hash
    if (expectHead !== undefined && (typeof expectHead !== 'string' || !HASH.test(expectHead) || expectHead !== head)) throw new Error(t('repoChanged'))
    if (backup !== undefined) {
      const target = tip === 'HEAD' ? head : await tipOf(git, `refs/heads/${await assertName(git, tip.branch, 'branch')}`)
      if (!target || (backup as { target?: unknown })?.target !== target) throw new Error(t('repoChanged'))
      if ((backup as { stash?: unknown }).stash === true && !hardReset) throw new Error(t('backupInvalid'))
      const result = await createBackup(git, backup)
      if (!result.ok) return { ok: false, message: result.message, ...(result.name ? { backup: result.name } : {}) }
      made = result
    }
  } catch (error) {
    return refused(error)
  }
  const result = await run()
  const head = result.ok ? (await readHead(git)).hash : null
  return { ...result, ...(made ? { backup: made.name, ...(made.stash ? { stash: made.stash } : {}) } : {}), ...(head ? { head } : {}) }
}

/** Deletes a `backup/` branch or tag, only while it still points at `hash`, the commit the user saw. Never throws. */
export async function deleteBackup(git: Git, action: unknown): Promise<ActionResult> {
  try {
    const { ref, name, hash } = (action ?? {}) as Partial<BackupDelete>
    if ((ref !== 'branch' && ref !== 'tag') || typeof name !== 'string' || !name.startsWith('backup/') || typeof hash !== 'string' || !HASH.test(hash)) {
      throw new Error(t('backupInvalid'))
    }
    const checked = await assertName(git, name, ref)
    if (checked !== name || (await tipOf(git, refName(ref, name))) !== hash) throw new Error(t('repoChanged'))
    await git.out(ref === 'branch' ? ['branch', '-D', name] : ['tag', '-d', name])
    return { ok: true, message: t('backupDeleted', { name }) }
  } catch (error) {
    return refused(error)
  }
}
