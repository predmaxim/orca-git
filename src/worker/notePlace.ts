import { placeTarget } from '../shared/notes.ts'
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

/**
 * The hunk headers of a `git diff` output; a count git leaves out is 1. git ends a line with LF only, and a line of the file
 * starts with +, - or a space, so it is never read as one: not even past a CR, U+2028 or U+2029 in it, which a regex's `^`
 * with the m flag would take for the start of a line.
 */
export function parseHunks(diff: string): Hunk[] {
  return diff.split('\n').flatMap((line): Hunk[] => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    return m ? [[Number(m[1]), Number(m[2] ?? 1), Number(m[3]), Number(m[4] ?? 1)]] : []
  })
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
 * The hunks between two blobs: from `cache` (a blob never changes) or one `git diff`. Null for binary content and for a diff
 * git was killed on (past the output cap or the time limit: the same blobs would be again), both kept, and when git refuses
 * (a blob it does not have), not kept: the blob may come with a fetch, or be in another repository. All logged.
 * `--inter-hunk-context=0`: diff.interHunkContext would join hunks over the unchanged lines between them. `--text`: a -diff or
 * binary attribute, which git matches against the blob ids too, would make it "Binary files differ"; so git compares binary
 * blobs as text too, and binary content is told by a NUL byte in the lines that changed. An empty GIT_DIFF_OPTS: git reads
 * its `--unified=<n>` over -U0, and the context lines would outdate notes next to a change.
 */
export async function blobHunks(git: Git, from: string, to: string, cache: Map<string, Hunk[] | null>): Promise<Hunk[] | null> {
  const key = `${from}:${to}`
  if (cache.has(key)) return cache.get(key) ?? null
  if (!hex(from) || !hex(to)) return null
  const diff = await git.run(['diff', '-U0', '--inter-hunk-context=0', '--text', '--no-color', '--no-ext-diff', '--no-textconv', from, to], { env: { GIT_DIFF_OPTS: '' } })
  if (!diff.ok) log(`notes not carried from ${from} to ${to}: ${lastLines(diff.stderr)}`)
  if (!diff.ok && !diff.stopped) return null
  // shortcut: git calls a blob binary for a NUL in its first 8000 bytes, this for one anywhere in a changed line (a note's own
  // blob, written on lines the Diff tab showed, has none); read the blobs' first bytes if a text file with a late NUL loses notes.
  const binary = diff.ok && diff.stdout.includes('\0')
  if (binary) log(`notes not carried from ${from} to ${to}: binary content`)
  if (cache.size >= MAX_PAIRS) cache.clear()
  const hunks = diff.ok && !binary ? parseHunks(diff.stdout) : null
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
      const target = placeTarget(note, file)
      const commit = note.side === 'new' ? file.to : file.from
      if (!hex(target) || !hex(note.blob) || !hex(note.rev) || !hex(commit)) continue
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

/**
 * The ids of the new-side notes of `notes` whose lines changed between their version of the file and HEAD's, or whose file HEAD
 * no longer has (removed or renamed): for the Notes list and the agent. Only notes whose commit is in HEAD's history: for one of
 * another branch or of a rewritten commit, HEAD's file is no later version of its lines. None for a HEAD without commits, and
 * none of a pair of blobs git does not compare (`blobHunks`).
 */
/**
 * Whether a note's commit is in the history of a HEAD, by `<rev> <head>`, for every repository and call: without a commit-graph
 * git walks the history for each, a second or more in a large repository, and every list of the notes asks again.
 */
const ancestry = new Map<string, boolean>()

export async function outdatedAtHead(git: Git, notes: ReviewNote[], cache: Map<string, Hunk[] | null>): Promise<Set<string>> {
  const outdated = new Set<string>()
  // One commit for every check of the call, though HEAD may move meanwhile.
  const head = (await git.run(['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim()
  if (!hex(head)) return outdated
  const ancestors = new Map<string, boolean>()
  const checked: ReviewNote[] = []
  for (const note of notes) {
    // A path is a line of cat-file's input.
    if (note.side !== 'new' || !hex(note.blob) || !hex(note.rev) || /[\r\n]/.test(note.path)) continue
    if (!ancestors.has(note.rev)) {
      const pair = `${note.rev} ${head}`
      let answer = ancestry.get(pair)
      if (answer === undefined) {
        const result = await git.run(['merge-base', '--is-ancestor', note.rev, head])
        if (result.code !== 0 && result.code !== 1 && result.code !== 128) log(`notes of ${note.rev} not checked against HEAD: ${lastLines(result.stderr)}`)
        answer = result.code === 0
        // Whether one commit is in the history of another never changes; a commit git does not know (128) may come with a fetch.
        if (result.code === 0 || result.code === 1) ancestry.set(pair, answer)
      }
      ancestors.set(note.rev, answer)
    }
    if (ancestors.get(note.rev)) checked.push(note)
  }
  if (!checked.length) return outdated
  // One process for every path, and a path only in its input: `<commit>:<path>` is never read as an option.
  const found = await git.run(['cat-file', '--batch-check'], { input: checked.map((note) => `${head}:${note.path}\n`).join('') })
  const lines = found.stdout.split('\n')
  if (!found.ok || lines.length !== checked.length + 1) {
    log(`notes not checked against HEAD: ${lastLines(found.stderr) || 'cat-file answered another number of lines'}`)
    return outdated
  }
  for (const [i, note] of checked.entries()) {
    // `<id> blob <size>`; anything else (`<name> missing`, a folder) is no file at the path.
    const blob = /^([0-9a-f]{40}) blob /.exec(lines[i])?.[1]
    if (!blob) outdated.add(note.id)
    else if (blob !== note.blob) {
      const hunks = await blobHunks(git, note.blob, blob, cache)
      if (hunks && !carryLines(hunks, note.start.line, note.end.line)) outdated.add(note.id)
    }
  }
  return outdated
}
