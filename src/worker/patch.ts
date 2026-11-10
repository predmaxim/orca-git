import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PatchResult } from '../shared/protocol.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'

const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants

/** Frame responses are capped at 1 MiB; bigger patches can only be saved. Bytes of the text as JSON, in UTF-8. */
export const MAX_PATCH_TEXT = 900_000

const slug = (subject: string) =>
  subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'commit'

/**
 * `git format-patch` output for `hashes`, oldest first, as one mbox: the bytes git wrote (file content need not be UTF-8)
 * and, when they are UTF-8, the text.
 */
export async function formatPatch(git: Git, hashes: string[]): Promise<{ bytes: Uint8Array; text: string | null; name: string }> {
  if (!Array.isArray(hashes) || !hashes.length) throw new Error(t('selectAtLeastOne'))
  if (!hashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{40}$/.test(hash))) throw new Error(t('invalidCommit'))
  const order = (await git.out(['rev-list', '--no-walk', '--topo-order', '--reverse', '--parents', ...new Set(hashes), '--']))
    .trim()
    .split('\n')
    .map((line) => line.split(' '))
  if (order.some((ids) => ids.length > 2)) throw new Error(t('mergeNoPatch'))
  const parts: Uint8Array[] = []
  for (const [hash] of order) {
    // --encoding=UTF-8: messages in UTF-8 whatever i18n.logOutputEncoding says; file content stays as it is.
    const result = await git.run(['format-patch', '--stdout', '--encoding=UTF-8', '--binary', '--no-signature', '-1', hash, '--'], { bytes: true })
    if (!result.ok || !result.bytes) throw new Error(lastLines(result.stderr) || t('gitCommandFailed', { command: 'format-patch' }))
    parts.push(result.bytes)
  }
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0)
  let text: string | null = null
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not UTF-8: only the bytes keep the patch applicable.
  }
  const subject = order.length === 1 ? (await git.out(['log', '-1', '--encoding=UTF-8', '--format=%s', order[0][0], '--'])).trim() : ''
  return { bytes, text, name: order.length === 1 ? `${slug(subject)}.patch` : `${order.length}-commits.patch` }
}

/** A folder by its device and inode, and its real path for a file system that reports no inode. */
type Folder = { dev: bigint; ino: bigint; real: string }

/** The folder at `path`, links followed; null when there is none. */
function folderAt(path: string): Folder | null {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
  return stat?.isDirectory() ? { dev: stat.dev, ino: stat.ino, real: realpathSync.native(path) } : null
}

/**
 * Whether `folder`, or a folder above it, is one of `gitDirs` under whatever name the file system gives it (a separate
 * git dir in the work tree; on NTFS `.git.`, `GIT~1`, `.git::$INDEX_ALLOCATION`): the same device and inode, or, where
 * there is no inode, the same real path, case and all. A folder that does not exist yet is skipped.
 */
function insideGitDir(folder: string, gitDirs: Folder[]): boolean {
  for (let path = folder; ; path = dirname(path)) {
    const here = folderAt(path)
    if (here && gitDirs.some((dir) => (dir.ino && here.ino ? dir.dev === here.dev && dir.ino === here.ino : dir.real === here.real))) return true
    if (dirname(path) === path) return false
  }
}

/** Returns the patch text, or writes it to `path` (relative to `root`) when one is given. */
export async function createPatch(git: Git, root: string, hashes: string[], path?: string, overwrite = false): Promise<PatchResult> {
  const { bytes, text, name } = await formatPatch(git, hashes)
  const size = bytes.length
  if (!path) {
    if (text === null) return { ok: true, name, size, notUtf8: true }
    // Bytes, not UTF-16 code units: a character outside ASCII takes up to 4, and JSON escapes a quote, a backslash or a newline.
    const large = size > MAX_PATCH_TEXT || new TextEncoder().encode(JSON.stringify(text)).length > MAX_PATCH_TEXT
    return large ? { ok: true, name, size, tooLarge: true } : { ok: true, name, size, text }
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
  // `GIT~1` and `.git::$INDEX_ALLOCATION`, reach them under a name the check above does not catch. No --path-format:
  // git before 2.31 prints it back as one more path. git prints each relative to the root it runs in, or absolute;
  // anything but exactly the two paths saves nothing.
  const lines = (await git.out(['rev-parse', '--git-dir', '--git-common-dir'])).replace(/\r?\n$/, '').split(/\r?\n/)
  if (lines.length !== 2 || lines.some((line) => !line)) return { ok: false, reason: t('gitOutputUnreadable', { command: 'rev-parse' }) }
  const gitDirs = lines.map((line) => folderAt(resolve(git.root, line)))
  if (gitDirs.includes(null)) return refused('patchPathRefused')
  try {
    // Through no link a repository could carry that leads elsewhere, and never onto a folder.
    const stats = parts.map((_, i) => lstatSync(join(root, ...parts.slice(0, i + 1)), { throwIfNoEntry: false }))
    if (stats.some((stat) => stat?.isSymbolicLink())) return refused('patchPathRefused')
    const last = stats.at(-1)
    if (last?.isDirectory()) return refused('patchPathFolder')
    // A FIFO would block the worker on open; a device or socket is no place for a patch either.
    if (last && !last.isFile()) return refused('patchPathNotFile')
    if (last && !overwrite) return exists
    if (insideGitDir(dirname(target), gitDirs as Folder[])) return refused('patchPathRefused')
    // The missing folders one at a time, each checked once it exists: a name only the file system resolves to the git
    // dir exists already (mkdir says so), so nothing is made inside it. A refusal removes the folders this call made.
    const made: string[] = []
    for (let i = 1; i < parts.length; i++) {
      if (stats[i - 1]) continue
      const folder = join(root, ...parts.slice(0, i))
      try {
        mkdirSync(folder)
        made.push(folder)
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
      }
      if (insideGitDir(folder, gitDirs as Folder[])) {
        for (const done of made.reverse()) rmdirSync(done)
        return refused('patchPathRefused')
      }
    }
    // Neither replaces a link made since the check: wx never opens an existing path, O_NOFOLLOW never follows one.
    // O_NONBLOCK: a FIFO swapped in since the check fails with ENXIO instead of blocking the worker.
    const fd = openSync(target, overwrite ? O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK : 'wx')
    try {
      writeFileSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
  } catch (error: any) {
    if (error?.code === 'EEXIST') return exists
    if (error?.code === 'ELOOP') return refused('patchPathRefused')
    return error?.code === 'ENOTDIR' ? refused('patchPathNotFolder') : refused('patchSaveFailed', String(error?.code ?? error))
  }
  return { ok: true, name, size, path: target }
}
