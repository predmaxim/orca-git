import { stateOf } from '../shared/notes.ts'
import type { DiffHunk, DiffLine, FileDiff, NotePoint, NoteSide, ReviewNote } from '../shared/protocol.ts'
import type { DiffMode } from './diff.ts'

/** Split: the column the selection starts in. Unified: a deleted line starts an old-side selection, any other a new-side one. */
export function pickSide(mode: DiffMode, column: 'left' | 'right', kind: DiffLine['kind']): NoteSide {
  if (mode === 'split') return column === 'left' ? 'old' : 'new'
  return kind === '-' ? 'old' : 'new'
}

/** The numbered lines of one side of the hunks. */
export function sideLines(hunks: DiffHunk[], side: NoteSide): Map<number, string> {
  const lines = new Map<number, string>()
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const n = side === 'old' ? line.old : line.new
      if (n !== undefined && line.kind !== (side === 'old' ? '+' : '-')) lines.set(n, line.text)
    }
  }
  return lines
}

/** A selection fitted to the side's lines, with its text; null when nothing of the side is selected. */
export function anchor(lines: Map<number, string>, from: NotePoint, to: NotePoint): { start: NotePoint; end: NotePoint; quote: string } | null {
  const nums = [...lines.keys()].sort((a, b) => a - b)
  const len = (n: number) => lines.get(n)!.length
  const before = (n: number) => nums.filter((x) => x < n).pop()
  const after = (n: number) => nums.find((x) => x > n)
  const [a, b] = from.line < to.line || (from.line === to.line && from.col <= to.col) ? [from, to] : [to, from]

  let end: NotePoint
  if (!lines.has(b.line) || (b.col <= 0 && b.line > a.line)) {
    const p = before(b.line)
    if (p === undefined) return null
    end = { line: p, col: len(p) }
  } else end = { line: b.line, col: Math.min(Math.max(b.col, 0), len(b.line)) }

  let start: NotePoint
  if (!lines.has(a.line)) {
    const n = after(a.line)
    if (n === undefined) return null
    start = { line: n, col: 0 }
  } else {
    start = { line: a.line, col: Math.min(Math.max(a.col, 0), len(a.line)) }
    if (start.col === len(a.line) && end.line > a.line) {
      const n = after(a.line)
      if (n === undefined) return null
      start = { line: n, col: 0 }
    }
  }

  if (start.line > end.line || (start.line === end.line && start.col >= end.col)) return null
  const quote = nums
    .filter((n) => n >= start.line && n <= end.line)
    .map((n) => lines.get(n)!.slice(n === start.line ? start.col : 0, n === end.line ? end.col : undefined))
    .join('\n')
  return { start, end, quote }
}

/** The notes whose side of this diff is their blob. */
export function notesOf(notes: ReviewNote[], diff: Pick<FileDiff, 'oldBlob' | 'newBlob'>): ReviewNote[] {
  return notes.filter((n) => n.blob === (n.side === 'old' ? diff.oldBlob : diff.newBlob))
}

/** The part [from, to) of a line a note covers; null when it covers none of it. */
export function coveredRange(note: Pick<ReviewNote, 'side' | 'start' | 'end'>, side: NoteSide, line: number, length: number): [number, number] | null {
  if (note.side !== side || line < note.start.line || line > note.end.line) return null
  const from = line === note.start.line ? note.start.col : 0
  const to = Math.min(line === note.end.line ? note.end.col : length, length)
  return from < to ? [from, to] : null
}

/** The notes the send button counts and sends: those whose state is unsent. */
export function unsent(notes: ReviewNote[]): ReviewNote[] {
  return notes.filter((n) => stateOf(n) === 'unsent')
}

/** All notes as markdown, for Copy all. */
export function notesText(notes: ReviewNote[]): string {
  return notes
    .map((n) => {
      const lines = n.start.line === n.end.line ? `${n.start.line}` : `${n.start.line}-${n.end.line}`
      const quote = n.quote.split('\n').map((l) => `> ${l}`).join('\n')
      const text = n.messages.filter((m) => m.author === 'user').map((m) => m.body).join('\n\n')
      return `${n.path}:${lines} (${n.side})\n${quote}\n\n${text}`
    })
    .join('\n\n---\n\n')
}
