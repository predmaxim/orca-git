// What moving HEAD to another commit would touch in the work tree, and the stash that puts it aside first.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckoutRisk } from '../shared/protocol.ts'
import { t } from '../shared/i18n.ts'
import { editedFiles, foundAt, realFile, untrackedAt } from './backup.ts'
import { lastLines, type Git } from './git.ts'
import { readHead } from './log.ts'

const LISTED = 50
const split = (out: string) => out.split('\0').filter(Boolean)

// Edits inside a submodule are left out: git switch never writes into one unless submodule.recurse is on, and then refuses them.
const STATUS = ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty']

/**
 * Paths of `git status --porcelain=v1 -z`: a rename or copy, in the index or in the files, gives its old path too.
 * `gone`: deleted from the index (a staged deletion, the old path of a staged rename).
 */
function statusPaths(out: string): { paths: string[]; gone: Set<string>; inFiles: string[] } {
  const entries = out.split('\0')
  const paths: string[] = []
  const gone = new Set<string>()
  // Changed in the files only (` M`): for a submodule, checked out at another commit.
  const inFiles: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry.startsWith(' M ')) inFiles.push(entry.slice(3))
    if (entry[0] === 'D') gone.add(entry.slice(3))
    if (!/[RC]/.test(entry.slice(0, 2))) continue
    paths.push(entries[++i])
    if (entry[0] === 'R') gone.add(entries[i])
  }
  return { paths: paths.filter(Boolean), gone, inFiles }
}

/**
 * Of `paths` (changed in the files only), the submodules merely checked out at another commit: a gitlink in the index
 * with a folder on disk. git switch leaves such a submodule alone and no stash can hold it, so it is no change here;
 * not with submodule.recurse on, where git switch moves it and can leave its own commits on no branch.
 */
async function movedSubmodules(git: Git, paths: string[]): Promise<Set<string>> {
  if (!paths.length || (await git.run(['config', '--type=bool', '--get', 'submodule.recurse'])).stdout.trim() === 'true') return new Set()
  const wanted = new Set(paths)
  // `<mode> <hash> <stage>\t<path>`
  const gitlinks = split(await git.out(['ls-files', '-z', '-s'])).filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1))
  return new Set(gitlinks.filter((path) => wanted.has(path) && ['folder', 'repository'].includes(foundAt(join(git.root, path)))))
}

/** Whether something other than a folder is at `path` (a file or a link where the target needs a folder). */
function notFolder(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * What moving HEAD to `commit` (40 hex) would touch, with full lists; null when that is nothing, or `commit` is HEAD's
 * own. Edits git hides from status (files marked assume-unchanged or skip-worktree, inside submodules) are left out:
 * `git switch` refuses or leaves them alone itself. Throws, before anything changes, when a nested repository stands
 * where the target writes: git looks neither for its files nor into it, and no stash can hold it.
 */
export async function checkoutRisk(git: Git, commit: string): Promise<CheckoutRisk | null> {
  const head = (await readHead(git)).hash
  if (head === commit) return null
  // A branch with no commits yet: compare with the empty tree.
  const from = head ?? (await git.out(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim()
  const status = statusPaths(await git.out(STATUS))
  const moved = await movedSubmodules(git, status.inFiles)
  const changed = status.paths.filter((path) => !moved.has(path))
  const differ = new Set(split(await git.out(['diff', '--name-only', '-z', '--no-renames', from, commit, '--'])))
  const conflicts = changed.filter((path) => differ.has(path))
  // Where the target writes a file: that path, and each folder of it that is not a folder on disk now.
  // `:<old mode> <new mode> <old> <new> <status>`, then the path; a gitlink (160000) is a submodule git moves itself.
  const raw = (await git.out(['diff', '-z', '--raw', '--no-renames', '--diff-filter=d', from, commit, '--'])).split('\0')
  const written: string[] = []
  const gitlinks = new Set<string>()
  for (let i = 0; i + 1 < raw.length; i += 2) {
    written.push(raw[i + 1])
    if (raw[i].split(' ')[1] === '160000') gitlinks.add(raw[i + 1])
  }
  const places = new Set(written)
  for (const path of written) {
    for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) {
      if (notFolder(join(git.root, path.slice(0, i)))) places.add(path.slice(0, i))
    }
  }
  const list = [...places]
  const untracked = list.length ? await untrackedAt(git, ['--exclude-standard'], list) : []
  const ignored = list.length ? await untrackedAt(git, ['-i', '--exclude-standard'], list) : []
  // A repository at or above a path the target writes, or one git lists (as `name/`) where it writes.
  const repositories = new Set([...untracked, ...ignored].filter((path) => path.endsWith('/')).map((path) => path.slice(0, -1)))
  for (const path of written.filter((path) => !gitlinks.has(path))) {
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const at = foundAt(join(git.root, ...parts.slice(0, i)))
      if (at === 'repository') repositories.add(parts.slice(0, i).join('/'))
      if (at !== 'folder') break
    }
  }
  if (repositories.size) throw new Error(t('repositoryInTheWay', { paths: [...repositories].sort().join(', ') }))
  if (!changed.length && !untracked.length && !ignored.length) return null
  return { changed, conflicts, untracked, ignored, carry: !conflicts.length && !untracked.length && !ignored.length, more: 0 }
}

/** The risk as a reply carries it: at most 50 paths in each list, the rest counted in `more`. */
export function trimRisk(risk: CheckoutRisk): CheckoutRisk {
  const lists = [risk.changed, risk.conflicts, risk.untracked, risk.ignored]
  const [changed, conflicts, untracked, ignored] = lists.map((list) => list.slice(0, LISTED))
  // Each path counted once: a conflict is among the changed files too.
  const all = new Set(lists.flat())
  const listed = new Set([changed, conflicts, untracked, ignored].flat())
  return { changed, conflicts, untracked, ignored, carry: risk.carry, more: risk.more + all.size - listed.size }
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
/**
 * Whether a file git hides from status has an edit: marked assume-unchanged (a lowercase tag in `ls-files -v`) or
 * skip-worktree (`S`). A stash of the whole tree skips such an edit, then writes the file back from the index.
 */
async function hiddenEdits(git: Git): Promise<boolean> {
  const hidden = split(await git.out(['ls-files', '-z', '-s', '-v'])).flatMap((line) => {
    // `<tag> <mode> <hash> <stage>\t<path>`
    const tab = line.indexOf('\t')
    const [tag, mode, hash] = line.slice(0, tab).split(' ')
    const path = line.slice(tab + 1)
    const hides = tag !== tag.toUpperCase() || tag === 'S'
    return hides && (mode === '100644' || mode === '100755') && realFile(git.root, path) ? [{ hash, path }] : []
  })
  return hidden.length > 0 && (await editedFiles(git, hidden)).length > 0
}

/** A stash made for a checkout; `error` when git failed after making it, so the checkout must not run. */
export interface Stash {
  hash: string
  name: string
  error?: string
}

/**
 * Our stash among those pushed after `before` (the top before the push), found by its name: refs/stash is shared by
 * every worktree, so another one may have pushed meanwhile. Empty when there is none.
 */
async function stashSince(git: Git, before: string, name: string): Promise<string> {
  const log = await git.run(['log', '-g', '-n', '20', '--format=%H%x09%s', 'refs/stash', '--'])
  for (const line of log.ok ? log.stdout.split('\n') : []) {
    const [hash, subject = ''] = line.split('\t')
    if (!hash || hash === before) break
    if (subject.endsWith(`: ${name}`)) return hash
  }
  return ''
}

const stashTop = async (git: Git) => (await git.run(['rev-parse', '--verify', '-q', 'refs/stash'])).stdout.trim()

/**
 * Moves into one new stash, named `git-log: <from> → <to>, <local time>`: the changes of tracked files, every
 * untracked file, and the ignored files in the target's way (`risk`, full lists); other ignored files stay.
 */
export async function stashForCheckout(git: Git, risk: CheckoutRisk, from: string, to: string): Promise<Stash | null> {
  const name = `git-log: ${from} → ${to}, ${stamp(new Date())}`
  const before = await stashTop(git)
  let result
  if (!risk.ignored.length && !(await hiddenEdits(git))) result = await git.run(['stash', 'push', '--include-untracked', '-m', name])
  else {
    // A list of paths: --all takes ignored files too, but only those it names, and the stash puts back only the listed
    // files, never a hidden edit. Each is literal, never a glob or pathspec magic; an empty list would mean the whole
    // tree, so with nothing listed there is no stash (what is left, a staged deletion, goes along with the checkout).
    // shortcut: git stash stages the listed paths with `git add`, which refuses one gone from both the index and the
    // disk, so a staged deletion (or a rename's old path) is left out and stays staged, carried along by the checkout;
    // nothing is lost. Upgrade if that mix (with ignored files in the way or hidden edits) ever matters.
    const { gone } = statusPaths(await git.out(STATUS))
    const untracked = split(await git.out(['ls-files', '-z', '-o', '--exclude-standard']))
    const paths = [...new Set([...risk.changed.filter((path) => !gone.has(path)), ...untracked, ...risk.ignored])]
    if (!paths.length) return null
    result = await git.run(['stash', 'push', '--all', '-m', name, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: paths.map((path) => `:(literal)${path}`).join('\0')
    })
  }
  const hash = await stashSince(git, before, name)
  const made = Boolean(hash)
  if (result.ok && made) return { hash, name }
  const error = `${t('stashFailed')}\n${lastLines(result.stderr || result.stdout, 4)}`.trim()
  if (!made) throw new Error(error)
  // git can fail after it recorded the stash (cleaning the files, say): then that stash holds what it saved.
  return { hash, name, error }
}
