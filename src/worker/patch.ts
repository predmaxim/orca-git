import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PatchResult } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'

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
  // Inside the work tree, outside any .git, and through no link a repository could carry that leads elsewhere.
  const linked = () => parts.some((_, i) => lstatSync(join(root, ...parts.slice(0, i + 1)), { throwIfNoEntry: false })?.isSymbolicLink())
  if (path.includes('\0') || !inside || parts[0] === '..' || isAbsolute(inside) || parts.some((part) => part.toLowerCase() === '.git') || linked()) {
    return { ok: false, reason: t('patchPathRefused', { path: target }) }
  }
  if (existsSync(target) && !overwrite) return { ok: false, exists: true, reason: t('fileExists', { path: target }) }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  return { ok: true, name, size: text.length, path: target }
}
