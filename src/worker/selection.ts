import type { FileDiff, SelectionFile } from '../shared/protocol.ts'
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
}

/** The files a set of commits changes together: each file from where the selection first touches it to where it last does. */
export async function readSelectionFiles(git: Git, hashes: string[]): Promise<SelectionFile[]> {
  if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > 500 || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) {
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
      if (f.status === 'R' && f.oldPath) {
        const e = entries.get(f.oldPath) ?? { orig: f.oldPath, from: parent, to: hash }
        entries.delete(f.oldPath)
        entries.set(f.path, { ...e, to: hash })
      } else {
        const e = entries.get(f.path) ?? { orig: f.path, from: parent, to: hash }
        entries.set(f.path, { ...e, to: hash })
      }
    }
  }
  const groups = new Map<string, Array<[string, Entry]>>()
  for (const item of entries) {
    const key = `${item[1].from}\0${item[1].to}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const tree = await emptyTree(git)
  const result: SelectionFile[] = []
  for (const items of groups.values()) {
    const { from, to } = items[0][1]
    const paths = [...new Set(items.flatMap(([path, e]) => [path, e.orig]))].map(literal)
    const diff = await git.out(['diff', '--name-status', '-z', '-M', from ?? tree, to, '--', ...paths])
    for (const change of parseNameStatus(diff)) {
      // A change shows under the current path, or under the original one when the file was renamed and then deleted.
      if (items.some(([path, e]) => path === change.path || e.orig === change.path || e.orig === change.oldPath)) result.push({ ...change, from, to })
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

/** The diff of one file between two revisions; `from` null means the empty tree. */
export async function readRangeDiff(git: Git, from: string | null, to: string, path: string, oldPath?: string, wholeFile = false): Promise<FileDiff> {
  if ((from !== null && !HASH.test(String(from))) || !HASH.test(String(to))) throw new Error(t('invalidCommit'))
  if (!path || typeof path !== 'string') throw new Error(t('missingFilePath'))
  const paths = [...(oldPath && oldPath !== path ? [literal(oldPath)] : []), literal(path)]
  const stdout = await git.out(['diff', '--no-ext-diff', '--no-textconv', '-M', `-U${wholeFile ? 1_000_000 : 3}`, from ?? (await emptyTree(git)), to, '--', ...paths])
  return { path, ...(oldPath ? { oldPath } : {}), ...parseUnifiedDiff(stdout) }
}
