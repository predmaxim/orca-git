import { t } from '../shared/i18n.ts'
import { lastAnswer, stateOf, unsentOf } from '../shared/notes.ts'
import type { DiffHunk, DiffLine, NoteMessage, NotePoint, NoteSide, ReviewNote } from '../shared/protocol.ts'
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

/** The part [from, to) of a line a note covers; null when it covers none of it. */
export function coveredRange(note: Pick<ReviewNote, 'side' | 'start' | 'end'>, side: NoteSide, line: number, length: number): [number, number] | null {
  if (note.side !== side || line < note.start.line || line > note.end.line) return null
  const from = line === note.start.line ? note.start.col : 0
  const to = Math.min(line === note.end.line ? note.end.col : length, length)
  return from < to ? [from, to] : null
}

/** The threads the Notes button counts: those not resolved. */
export function active(notes: ReviewNote[]): ReviewNote[] {
  return notes.filter((n) => n.resolvedAt === undefined)
}

/** The notes the send button counts and sends: those whose state is unsent. */
export function unsent(notes: ReviewNote[]): ReviewNote[] {
  return notes.filter((n) => stateOf(n) === 'unsent')
}

/** Who wrote a message: You, or Agent with its kind when it is known. */
export function authorOf(m: NoteMessage): string {
  return m.author === 'user' ? t('noteYou') : m.agent ? t('noteAgent', { agent: m.agent }) : t('noteAgentPlain')
}

/** The longest pause between two messages of one group, in ms. */
export const GROUP_GAP_MS = 5 * 60_000

/**
 * Whether `m` goes on in the group of `prev`, under its header: the same author, the same send (both unsent, or one `review` and `sentAt`),
 * at most GROUP_GAP_MS later and not earlier.
 */
export function continues(prev: NoteMessage | undefined, m: NoteMessage): boolean {
  // One send stamps one sentAt on all its messages, which stays when deleting its answer takes `review` off them.
  if (!prev || prev.author !== m.author || prev.review !== m.review || prev.sentAt !== m.sentAt) return false
  const gap = m.at - prev.at
  return gap >= 0 && gap <= GROUP_GAP_MS
}

/** Whether a message shows its verdict: an agent's with one, unless it is the last answer of an answered thread, whose label says it. */
export function showsVerdict(n: ReviewNote, m: NoteMessage): boolean {
  return m.author === 'agent' && m.verdict !== undefined && !(stateOf(n) === 'answered' && lastAnswer(n) === m)
}

/** Whether the unsent messages say Not sent: only next to sent ones; when nothing went out, the thread's label says it. */
export function marksUnsent(n: ReviewNote): boolean {
  return unsentOf(n).length > 0 && n.messages.some((m) => m.author === 'user' && m.sentAt !== undefined)
}

/** Where a note is: "Line 40 · new" or "Lines 44–46 · old". */
export function whereOf(n: Pick<ReviewNote, 'side' | 'start' | 'end'>): string {
  const side = t(n.side === 'old' ? 'noteSideOld' : 'noteSideNew')
  return n.start.line === n.end.line ? t('noteWhereLine', { line: n.start.line, side }) : t('noteWhereLines', { start: n.start.line, end: n.end.line, side })
}

/** Bytes of an image part: a multiple of 3, so its base64 has no padding and is the 60000 characters the worker takes. */
const PART = 45000

/** The parts a file of `bytes` bytes is sent in: [offset, length] of at most 45000 bytes each. */
export function uploadParts(bytes: number): [number, number][] {
  const parts: [number, number][] = []
  for (let at = 0; at < bytes; at += PART) parts.push([at, Math.min(PART, bytes - at)])
  return parts
}

/** Base64 of `bytes`; the binary string grows in slices, as a spread of a large array would overflow the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** The bytes of base64 `data`. */
export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
}

/** All threads as markdown, for Copy all: every message under its author, oldest first. */
export function notesText(notes: ReviewNote[]): string {
  return notes
    .map((n) => {
      const lines = n.start.line === n.end.line ? `${n.start.line}` : `${n.start.line}-${n.end.line}`
      const quote = n.quote.split('\n').map((l) => `> ${l}`).join('\n')
      const text = n.messages.map((m) => `**${authorOf(m)}:**\n${m.body}`).join('\n\n')
      return `${n.path}:${lines} (${n.side})\n${quote}\n\n${text}`
    })
    .join('\n\n---\n\n')
}
