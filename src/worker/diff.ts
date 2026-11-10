import type { DiffHunk, FileDiff } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'

/** Lines kept per file; beyond this the diff is marked truncated. */
export const MAX_DIFF_LINES = 20_000
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

/** Parses the unified diff of a single file. */
export function parseUnifiedDiff(stdout: string, maxLines = MAX_DIFF_LINES): Pick<FileDiff, 'binary' | 'truncated' | 'hunks'> {
  const hunks: DiffHunk[] = []
  let binary = false
  let truncated = false
  let count = 0
  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true
    }
    const header = HUNK.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = { oldStart: oldLine, newStart: newLine, section: header[3].trim(), lines: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('diff --git ')) break
    const kind = line[0]
    if (kind !== ' ' && kind !== '+' && kind !== '-') continue
    if (++count > maxLines) {
      truncated = true
      break
    }
    const text = line.slice(1)
    if (kind === ' ') hunk.lines.push({ kind, text, old: oldLine++, new: newLine++ })
    else if (kind === '-') hunk.lines.push({ kind, text, old: oldLine++ })
    else hunk.lines.push({ kind, text, new: newLine++ })
  }
  return { binary, truncated, hunks }
}

const literal = (path: string) => `:(literal)${path}`

/** The changes `hash` made to `path` (renamed from `oldPath`), against its first parent. */
export async function readFileDiff(git: Git, hash: string, path: string, oldPath?: string, wholeFile = false): Promise<FileDiff> {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(t('invalidCommitDetail', { hash }))
  if (!path || typeof path !== 'string') throw new Error(t('missingFilePath'))
  const parents = (await git.out(['rev-list', '--parents', '-n1', hash, '--'])).trim().split(' ').slice(1)
  const paths = [...(oldPath && oldPath !== path ? [literal(oldPath)] : []), literal(path)]
  // --no-color: -c color.ui=false does not override a color.diff=always the user set, and coloured lines parse as no hunk.
  const options = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', `-U${wholeFile ? 1_000_000 : 3}`]
  const args = parents.length
    ? ['diff', ...options, parents[0], hash, '--', ...paths]
    : ['diff-tree', '-p', '--root', '--no-commit-id', ...options, hash, '--', ...paths]
  return { path, ...(oldPath ? { oldPath } : {}), ...parseUnifiedDiff(await git.out(args)) }
}
