import type { DiffHunk, DiffLine } from '../shared/protocol.ts'

export interface SplitRow {
  left?: DiffLine
  right?: DiffLine
}

/** Side-by-side rows: context on both sides, each run of deletions paired with the additions after it. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  const lines = hunk.lines
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind === ' ') {
      rows.push({ left: lines[i], right: lines[i] })
      i++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (i < lines.length && lines[i].kind === '-') removed.push(lines[i++])
    while (i < lines.length && lines[i].kind === '+') added.push(lines[i++])
    for (let k = 0; k < Math.max(removed.length, added.length); k++) rows.push({ left: removed[k], right: added[k] })
  }
  return rows
}

/** The changed middle of two versions of a line, as [start, oldEnd, newEnd]; null when nothing is shared. */
export function changedRange(before: string, after: string): [number, number, number] | null {
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before[start] === after[start]) start++
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  if (start === 0 && end === 0) return null
  return [start, before.length - end, after.length - end]
}

export type ChangeKind = 'added' | 'deleted' | 'modified'
/** A run of changed rows, `start` to `end` inclusive: what F7 goes to and the map of the file shows. */
export interface ChangeBlock { start: number; end: number; kind: ChangeKind }

/** The blocks of changed rows: only additions are added, only deletions deleted, both in a block modified. */
export function changeBlocks(rows: { add: boolean; del: boolean }[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  rows.forEach((row, i) => {
    if (!row.add && !row.del) return
    const kind: ChangeKind = row.add && row.del ? 'modified' : row.add ? 'added' : 'deleted'
    const last = blocks[blocks.length - 1]
    if (last?.end !== i - 1) blocks.push({ start: i, end: i, kind })
    else {
      last.end = i
      if (last.kind !== kind) last.kind = 'modified'
    }
  })
  return blocks
}
