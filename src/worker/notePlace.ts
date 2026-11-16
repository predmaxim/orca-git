import { noteBlob } from '../shared/notes.ts'
import type { NotePlace, ReviewNote, SelectionFile } from '../shared/protocol.ts'
import { lastLines, type Git } from './git.ts'

const HASH = /^[0-9a-f]{40}$/
const hex = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)
/** Pairs of blobs kept at most: past it the cache starts again. */
const MAX_PAIRS = 1000

/** A hunk header of `git diff -U0`: `@@ -oldStart,oldCount +newStart,newCount @@`. */
export type Hunk = [oldStart: number, oldCount: number, newStart: number, newCount: number]

let log: (line: string) => void = () => undefined
/** Where carrying notes reports what git did not answer. */
export const setPlaceLog = (write: (line: string) => void): void => {
  log = write
}

/** The hunk headers of a `git diff` output; a count git leaves out is 1. A line of the file starts with +, - or a space, so it is never read as one. */
export function parseHunks(diff: string): Hunk[] {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => [Number(m[1]), Number(m[2] ?? 1), Number(m[3]), Number(m[4] ?? 1)])
}

/**
 * Lines `start..end` of the old side of `hunks` on their new side: moved by what the hunks wholly above them add or remove;
 * null when a hunk touches them. A hunk with old count 0 inserts after its old start, so it touches them when it inserts
 * between two of them.
 */
export function carryLines(hunks: Hunk[], start: number, end: number): { start: number; end: number } | null {
  let shift = 0
  for (const [oldStart, oldCount, , newCount] of hunks) {
    const last = oldCount ? oldStart + oldCount - 1 : oldStart
    if (oldCount ? oldStart <= end && last >= start : start <= oldStart && oldStart < end) return null
    if (last < start) shift += newCount - oldCount
  }
  return { start: start + shift, end: end + shift }
}

/**
 * The hunks between two blobs: from `cache` (a blob never changes) or one `git diff`. Null for binary content, kept, and when
 * git gives none (a blob it does not have), not kept: the blob may come with a fetch, or be in another repository. Both logged.
 * `--inter-hunk-context=0`: diff.interHunkContext would join hunks over the unchanged lines between them. `--text`: a -diff or
 * binary attribute, which git matches against the blob ids too, would make it "Binary files differ"; so git compares binary
 * blobs as text too, and binary content is told by a NUL byte in the lines that changed.
 */
export async function blobHunks(git: Git, from: string, to: string, cache: Map<string, Hunk[] | null>): Promise<Hunk[] | null> {
  const key = `${from}:${to}`
  if (cache.has(key)) return cache.get(key) ?? null
  if (!hex(from) || !hex(to)) return null
  const diff = await git.run(['diff', '-U0', '--inter-hunk-context=0', '--text', '--no-color', '--no-ext-diff', '--no-textconv', from, to])
  if (!diff.ok) {
    log(`notes not carried from ${from} to ${to}: ${lastLines(diff.stderr)}`)
    return null
  }
  // shortcut: git calls a blob binary for a NUL in its first 8000 bytes, this for one anywhere in a changed line (a note's own
  // blob, written on lines the Diff tab showed, has none); read the blobs' first bytes if a text file with a late NUL loses notes.
  const binary = diff.stdout.includes('\0')
  if (binary) log(`notes not carried from ${from} to ${to}: binary content`)
  if (cache.size >= MAX_PAIRS) cache.clear()
  const hunks = binary ? null : parseHunks(diff.stdout)
  cache.set(key, hunks)
  return hunks
}

/**
 * Per file of `files`, in order: the notes written on another version of one of its sides, carried to that side's lines, or
 * outdated when their lines changed there (new side only: an old-side note sits on lines its own commit removed, and is only
 * carried). A candidate has the side's path (or, on the new side, the path before a rename in this diff) and another blob than
 * the side's; a side older than the note (its commit an ancestor of the note's) does not get it. Resolved notes are carried too.
 */
export async function placeNotes(git: Git, notes: ReviewNote[], files: SelectionFile[], cache: Map<string, Hunk[] | null>): Promise<NotePlace[][]> {
  const placed: NotePlace[][] = []
  for (const file of files) {
    const places: NotePlace[] = []
    for (const note of notes) {
      const target = noteBlob(file, note.side)
      const commit = note.side === 'new' ? file.to : file.from
      const samePath = note.side === 'new' ? note.path === file.path || note.path === file.oldPath : note.path === (file.oldPath ?? file.path)
      if (!samePath || !hex(target) || note.blob === target || !hex(note.blob) || !hex(note.rev) || !hex(commit)) continue
      if (commit !== note.rev) {
        // 1: not an ancestor; 128: a commit git does not know (rewritten by a fixup, a squash or a rebase, then collected). Both
        // are carried: the blobs are compared directly, so the history between them does not matter.
        const older = await git.run(['merge-base', '--is-ancestor', commit, note.rev])
        if (older.code !== 1 && older.code !== 128) {
          if (older.code !== 0) log(`note ${note.id} not carried: ${lastLines(older.stderr)}`)
          continue
        }
      }
      const hunks = await blobHunks(git, note.blob, target, cache)
      if (!hunks) continue
      const lines = carryLines(hunks, note.start.line, note.end.line)
      if (lines) places.push({ id: note.id, start: { line: lines.start, col: note.start.col }, end: { line: lines.end, col: note.end.col } })
      else if (note.side === 'new') places.push({ id: note.id, outdated: true })
    }
    placed.push(places)
  }
  return placed
}
