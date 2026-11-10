import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PatchResult } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'

const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants

/** Frame responses are capped at 1 MiB; bigger patches can only be saved. */
export const MAX_PATCH_TEXT = 900_000

const slug = (subject: string) =>
  subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'commit'

/** `git format-patch` output for `hashes`, oldest first, as one mbox. */
export async function formatPatch(git: Git, hashes: string[]): Promise<{ text: string; name: string }> {
  if (!Array.isArray(hashes) || !hashes.length) throw new Error(t('selectAtLeastOne'))
  if (!hashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{40}$/.test(hash))) throw new Error(t('invalidCommit'))
  const order = (await git.out(['rev-list', '--no-walk', '--topo-order', '--reverse', '--parents', ...new Set(hashes), '--']))
    .trim()
    .split('\n')
    .map((line) => line.split(' '))
  if (order.some((ids) => ids.length > 2)) throw new Error(t('mergeNoPatch'))
  const parts: string[] = []
  for (const [hash] of order) parts.push(await git.out(['format-patch', '--stdout', '--binary', '--no-signature', '-1', hash, '--']))
  const subject = order.length === 1 ? (await git.out(['log', '-1', '--format=%s', order[0][0], '--'])).trim() : ''
  return { text: parts.join(''), name: order.length === 1 ? `${slug(subject)}.patch` : `${order.length}-commits.patch` }
}

/**
 * Whether `folder`, or the nearest folder above it that exists, is one of `gitDirs` (real paths, lower case) or inside
 * one, once links and other names for the same folder are resolved. Lower case: refusing too much is safe.
 */
function insideGitDir(folder: string, gitDirs: string[]): boolean {
  let existing = folder
  while (!lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing)
  const real = realpathSync.native(existing).toLowerCase()
  return gitDirs.some((dir) => real === dir || real.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`))
}

/** Returns the patch text, or writes it to `path` (relative to `root`) when one is given. */
export async function createPatch(git: Git, root: string, hashes: string[], path?: string, overwrite = false): Promise<PatchResult> {
  const { text, name } = await formatPatch(git, hashes)
  if (!path) {
    return text.length > MAX_PATCH_TEXT ? { ok: true, name, size: text.length, tooLarge: true } : { ok: true, name, size: text.length, text }
  }
  if (typeof path !== 'string' || !path.trim()) return { ok: false, reason: t('enterFilePath') }
  const target = resolve(root, path.trim())
  const inside: string = relative(root, target)
  const parts = inside.split(sep)
  const refused = (key: 'patchPathRefused' | 'patchPathFolder' | 'patchPathNotFile' | 'patchPathNotFolder' | 'patchSaveFailed', code = '') => ({ ok: false as const, reason: t(key, { path: target, code }) })
  const exists = { ok: false as const, exists: true, reason: t('fileExists', { path: target }) }
  // Inside the work tree and outside any .git.
  if (path.includes('\0') || !inside || parts[0] === '..' || isAbsolute(inside) || parts.some((part) => part.toLowerCase() === '.git')) return refused('patchPathRefused')
  // The git dir and the common dir, wherever they are: a separate git dir in the work tree, or on NTFS `.git.`,
  // `GIT~1` and `.git::$INDEX_ALLOCATION`, reach them under a name the check above does not catch.
  const gitDirs = (await git.out(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((dir) => realpathSync.native(dir).toLowerCase())
  try {
    // Through no link a repository could carry that leads elsewhere, and never onto a folder.
    const stats = parts.map((_, i) => lstatSync(join(root, ...parts.slice(0, i + 1)), { throwIfNoEntry: false }))
    if (stats.some((stat) => stat?.isSymbolicLink())) return refused('patchPathRefused')
    const last = stats.at(-1)
    if (last?.isDirectory()) return refused('patchPathFolder')
    // A FIFO would block the worker on open; a device or socket is no place for a patch either.
    if (last && !last.isFile()) return refused('patchPathNotFile')
    if (last && !overwrite) return exists
    // Before any folder is made, and again once the patch's folder exists: a name only the file system resolves.
    if (insideGitDir(dirname(target), gitDirs)) return refused('patchPathRefused')
    mkdirSync(dirname(target), { recursive: true })
    if (insideGitDir(dirname(target), gitDirs)) return refused('patchPathRefused')
    // Neither replaces a link made since the check: wx never opens an existing path, O_NOFOLLOW never follows one.
    // O_NONBLOCK: a FIFO swapped in since the check fails with ENXIO instead of blocking the worker.
    const fd = openSync(target, overwrite ? O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK : 'wx')
    try {
      writeFileSync(fd, text)
    } finally {
      closeSync(fd)
    }
  } catch (error: any) {
    if (error?.code === 'EEXIST') return exists
    if (error?.code === 'ELOOP') return refused('patchPathRefused')
    return error?.code === 'ENOTDIR' ? refused('patchPathNotFolder') : refused('patchSaveFailed', String(error?.code ?? error))
  }
  return { ok: true, name, size: text.length, path: target }
}
