import { lstatSync } from 'node:fs'
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

/**
 * What a hard reset to `target` would lose: whether tracked files have uncommitted changes, and the
 * untracked files, ignored ones included, it overwrites: those at a path `target` tracks and HEAD does
 * not (or inside a folder there, or inside a nested repository), and those standing where `target` needs
 * a folder. Nested repositories the reset deletes whole are listed apart, as `name/`. `root` is the
 * repository's top level.
 */
export async function checkReset(git: Git, root: string, target: unknown): Promise<ResetCheck> {
  if (typeof target !== 'string' || !HASH.test(target)) throw new Error(t('invalidCommit'))
  const dirty = (await git.out(['status', '--porcelain', '-z', '--untracked-files=no'])) !== ''
  // On a branch with no commits yet, every file of the target is new.
  const listed = (await readHead(git)).hash
    ? await git.out(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', 'HEAD', target, '--'])
    : await git.out(['ls-tree', '-r', '-z', '--name-only', target])
  const added = listed.split('\0').filter(Boolean)
  const folders = new Set(added.flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))
  // --directory lists an untracked folder as one `name/` line, so only a file named like a folder matches it.
  const blocking = (await untrackedAt(git, ['--directory'], [...folders])).filter((path) => folders.has(path))
  const found = [...new Set([...(await untrackedAt(git, [], added)), ...blocking, ...insideNestedRepos(root, added)])].sort()
  // Git lists a nested repository as `name/`; the walk lists one without the slash.
  const isRepository = (path: string) => foundAt(`${root}/${path.replace(/\/$/, '')}`) === 'repository'
  return {
    dirty,
    overwritten: found.filter((path) => !isRepository(path)),
    repositories: found.filter(isRepository).map((path) => path.replace(/\/?$/, '/'))
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
