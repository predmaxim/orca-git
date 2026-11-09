import type { FileChange, FileDiff, SelectionFile } from '../shared/protocol.ts'
import { oldestFirst } from './actions.ts'
import { parseUnifiedDiff } from './diff.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { parseNameStatus } from './log.ts'

const HASH = /^[0-9a-f]{40}$/
const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' }
const literal = (path: string) => `:(literal)${path}`

async function emptyTree(git: Git): Promise<string> {
  const format = (await git.out(['rev-parse', '--show-object-format'])).trim()
  return format === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1
}

interface Entry {
  orig: string
  from: string | null
  to: string
  /** The change itself while a single selected commit is all that touches the file. */
  only?: FileChange
}

/** The files a set of commits changes together: each file from where the selection first touches it to where it last does. */
export async function readSelectionFiles(git: Git, hashes: string[]): Promise<SelectionFile[]> {
  if (Array.isArray(hashes) && hashes.length > 500) throw new Error(t('selectionTooLarge'))
  if (!Array.isArray(hashes) || hashes.length < 1 || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) {
    throw new Error(t('invalidSelection'))
  }
  const order = await oldestFirst(git, hashes)
  const log = await git.out(['log', '--no-walk=unsorted', '--format=%x1e%H%x1f%P', '-z', '--name-status', '-M', '--root', '--diff-merges=first-parent', ...order, '--'])
  const entries = new Map<string, Entry>()
  for (const record of log.split('\x1e').filter(Boolean)) {
    const end = record.indexOf('\0')
    const header = end < 0 ? record : record.slice(0, end)
    const [hash, parents] = header.split('\x1f')
    const parent = parents.split(' ')[0] || null
    for (const f of end < 0 ? [] : parseNameStatus(record.slice(end + 1))) {
      const key = f.status === 'R' && f.oldPath ? f.oldPath : f.path
      const e = entries.get(key)
      entries.delete(key)
      entries.set(f.path, e ? { ...e, to: hash, only: undefined } : { orig: key, from: parent, to: hash, only: f })
    }
  }
  const result: SelectionFile[] = []
  const groups = new Map<string, Array<[string, Entry]>>()
  for (const [path, e] of entries) {
    // One commit's own change is exactly what a diff over its range would say; only files several commits touch need one.
    if (e.only) result.push({ ...e.only, from: e.from, to: e.to })
    else {
      const key = `${e.from}\0${e.to}`
      groups.set(key, [...(groups.get(key) ?? []), [path, e]])
    }
  }
  const tree = await emptyTree(git)
  const queue = [...groups.values()]
  // Each group keeps its own changes: the parallel diffs finish in any order.
  const found = new Map(queue.map((items) => [items, [] as SelectionFile[]]))
  const diffGroups = async () => {
    for (let items = queue.shift(); items; items = queue.shift()) {
      const { from, to } = items[0][1]
      const paths = [...new Set(items.flatMap(([path, e]) => [path, e.orig]))].map(literal)
      const diff = await git.out(['diff', '--name-status', '-z', '-M', from ?? tree, to, '--', ...paths])
      for (const change of parseNameStatus(diff)) {
        // A change shows under the current path, or under the original one when the file was renamed and then deleted.
        if (items.some(([path, e]) => path === change.path || (change.status === 'D' && e.orig === change.path) || e.orig === change.oldPath)) found.get(items)!.push({ ...change, from, to })
      }
    }
  }
  // A few git processes at a time: a large selection can have hundreds of groups. The first failure stops the rest.
  await Promise.all(Array.from({ length: 8 }, diffGroups)).catch((error) => {
    queue.length = 0
    throw error
  })
  const position = new Map(order.map((hash, i) => [hash, i]))
  // A path can come twice (deleted, then added again): the older change first.
  return [...result, ...[...found.values()].flat()].sort((a, b) => a.path.localeCompare(b.path) || position.get(a.to)! - position.get(b.to)!)
}

/** The diff of one file between two revisions; `from` null means the empty tree. */
export async function readRangeDiff(git: Git, from: string | null, to: string, path: string, oldPath?: string, wholeFile = false): Promise<FileDiff> {
  if ((from !== null && !HASH.test(String(from))) || !HASH.test(String(to))) throw new Error(t('invalidCommit'))
  if (!path || typeof path !== 'string') throw new Error(t('missingFilePath'))
  const paths = [...(oldPath && oldPath !== path ? [literal(oldPath)] : []), literal(path)]
  const stdout = await git.out(['diff', '--no-ext-diff', '--no-textconv', '-M', `-U${wholeFile ? 1_000_000 : 3}`, from ?? (await emptyTree(git)), to, '--', ...paths])
  return { path, ...(oldPath ? { oldPath } : {}), ...parseUnifiedDiff(stdout) }
}
