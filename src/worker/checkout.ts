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

const STATUS = ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty']

/** Paths of `git status --porcelain=v1 -z`: a rename or copy gives its old path too. `gone`: deleted from the index. */
function statusPaths(out: string): { paths: string[]; gone: Set<string> } {
  const entries = out.split('\0')
  const paths: string[] = []
  const gone = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'D') gone.add(entry.slice(3))
    if (entry[0] !== 'R' && entry[0] !== 'C') continue
    paths.push(entries[++i])
    if (entry[0] === 'R') gone.add(entries[i])
  }
  return { paths: paths.filter(Boolean), gone }
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
  const changed = statusPaths(await git.out(STATUS)).paths
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
  const more = lists.reduce((sum, list) => sum + Math.max(0, list.length - LISTED), risk.more)
  const [changed, conflicts, untracked, ignored] = lists.map((list) => list.slice(0, LISTED))
  return { changed, conflicts, untracked, ignored, carry: risk.carry, more }
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

const stashTop = async (git: Git) => (await git.run(['rev-parse', '--verify', '-q', 'refs/stash'])).stdout.trim()

/**
 * Moves into one new stash, named `git-log: <from> → <to>, <local time>`: the changes of tracked files, every
 * untracked file, and the ignored files in the target's way (`risk`, full lists); other ignored files stay.
 */
export async function stashForCheckout(git: Git, risk: CheckoutRisk, from: string, to: string): Promise<{ hash: string; name: string } | null> {
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
  const hash = await stashTop(git)
  if (!result.ok || !hash || hash === before) throw new Error(`${t('stashFailed')}\n${lastLines(result.stderr || result.stdout, 4)}`.trim())
  return { hash, name }
}
