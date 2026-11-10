import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PatchResult } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'

const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW = 0 } = constants

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
  const refused = (key: 'patchPathRefused' | 'patchPathFolder' | 'patchPathNotFolder' | 'patchSaveFailed', code = '') => ({ ok: false as const, reason: t(key, { path: target, code }) })
  const exists = { ok: false as const, exists: true, reason: t('fileExists', { path: target }) }
  // Inside the work tree and outside any .git.
  if (path.includes('\0') || !inside || parts[0] === '..' || isAbsolute(inside) || parts.some((part) => part.toLowerCase() === '.git')) return refused('patchPathRefused')
  try {
    // Through no link a repository could carry that leads elsewhere, and never onto a folder.
    const stats = parts.map((_, i) => lstatSync(join(root, ...parts.slice(0, i + 1)), { throwIfNoEntry: false }))
    if (stats.some((stat) => stat?.isSymbolicLink())) return refused('patchPathRefused')
    if (stats.at(-1)?.isDirectory()) return refused('patchPathFolder')
    if (stats.at(-1) && !overwrite) return exists
    mkdirSync(dirname(target), { recursive: true })
    // Neither replaces a link made since the check: wx never opens an existing path, O_NOFOLLOW never follows one.
    const fd = openSync(target, overwrite ? O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW : 'wx')
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
