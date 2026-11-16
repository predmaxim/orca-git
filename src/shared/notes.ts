import type { NoteMessage, NotePlace, NoteSide, ReviewNote, SelectionFile } from './protocol.ts'

/** Limits of review notes; the worker enforces them, the frames use them to size inputs. */
export const MAX_NOTES = 200
export const MAX_MESSAGES = 100
export const MAX_QUOTE = 2000
export const MAX_BODY = 4000
export const MAX_REPLY = 8000
/** Review skills per repository. */
export const MAX_REVIEW_SKILLS = 10

/** The user's messages not sent yet. */
export function unsentOf(note: ReviewNote): NoteMessage[] {
  return note.messages.filter((m) => m.author === 'user' && m.sentAt === undefined)
}

/** The send the user's last sent message went out with, when no agent message answers it. */
export function waitingFor(note: ReviewNote): string | undefined {
  const review = note.messages.filter((m) => m.author === 'user' && m.sentAt !== undefined).pop()?.review
  return review !== undefined && !note.messages.some((m) => m.author === 'agent' && m.review === review) ? review : undefined
}

export type NoteState = 'resolved' | 'unsent' | 'waiting' | 'answered' | 'idle'

/** A thread waits for one send at a time: while it waits, its new text is not sent, so waiting comes before unsent. */
export function stateOf(note: ReviewNote): NoteState {
  if (note.resolvedAt !== undefined) return 'resolved'
  if (waitingFor(note) !== undefined) return 'waiting'
  if (unsentOf(note).length) return 'unsent'
  return note.messages[note.messages.length - 1]?.author === 'agent' ? 'answered' : 'idle'
}

/** The agent's last message. */
export function lastAnswer(note: ReviewNote): NoteMessage | undefined {
  return note.messages.filter((m) => m.author === 'agent').pop()
}

/** Images of review messages: at most 5 MiB each, 5 per message; an id is 12 hex of the sha256 of the content and the kind's extension. */
export const MAX_IMAGE_BYTES = 5242880
export const MAX_IMAGES = 5
export const IMAGE_ID = /^[0-9a-f]{12}\.(png|jpg|gif|webp)$/

/**
 * The blob a note on this side of a file of a selection is tied to, for the panel and the Diff tab alike; none on a file whose
 * two sides are one blob (a pure rename or mode change) or a type change (git prints its diff as a deletion and an addition).
 */
export function noteBlob(file: Pick<SelectionFile, 'status' | 'oldBlob' | 'newBlob'>, side: NoteSide): string | undefined {
  if (file.oldBlob === file.newBlob || file.status === 'T') return undefined
  return side === 'old' ? file.oldBlob : file.newBlob
}

/** Open notes by line, then resolved ones by line. */
const byLine = (a: ReviewNote, b: ReviewNote): number => Number(a.resolvedAt !== undefined) - Number(b.resolvedAt !== undefined) || a.start.line - b.start.line

/** The notes the Diff tab shows on this file of a selection (`noteBlob`), open ones by line, then resolved ones by line. */
export function notesOfFile(notes: ReviewNote[], file: SelectionFile): ReviewNote[] {
  return notes.filter((n) => n.blob === noteBlob(file, n.side)).sort(byLine)
}

/**
 * The blob of a side of `file` that `notes.place` may carry `note` to: the side's (`noteBlob`), when the note has the side's path
 * (on the new side, also the path before a rename in this diff) and another blob. One rule for the worker and the frames that ask it.
 */
export function placeTarget(note: Pick<ReviewNote, 'side' | 'path' | 'blob'>, file: SelectionFile): string | undefined {
  const blob = noteBlob(file, note.side)
  const path = note.side === 'new' ? note.path === file.path || note.path === file.oldPath : note.path === (file.oldPath ?? file.path)
  return path && blob !== note.blob ? blob : undefined
}

/** Files one `notes.place` request takes at most: a frame's message holds at most 64 KiB. */
export const PLACE_FILES = 100

/** Whether `notes.place` may carry a note of another version of a side of `file` to it (`placeTarget`). */
export function placeCandidate(notes: ReviewNote[], file: SelectionFile): boolean {
  return notes.some((n) => placeTarget(n, file) !== undefined)
}

/** Copies of the notes `places` carries to a file, at their lines there; the outdated ones and notes gone are left out. */
export function carriedNotes(notes: ReviewNote[], places: NotePlace[]): ReviewNote[] {
  return places.flatMap((p) => {
    if (!('start' in p)) return []
    const note = notes.find((n) => n.id === p.id)
    return note ? [{ ...note, start: p.start, end: p.end }] : []
  })
}

/**
 * The notes the Files section lists under a file: its own and those `places` carries to it, at their lines there, and the outdated
 * ones at their own lines with `outdated`; open ones by line, then resolved ones by line. The list's `outdated` (as of HEAD) is left off.
 */
export function notesUnder(notes: ReviewNote[], file: SelectionFile, places: NotePlace[]): ReviewNote[] {
  const outdated = new Set(places.flatMap((p) => ('start' in p ? [] : [p.id])))
  return [
    ...[...notesOfFile(notes, file), ...carriedNotes(notes, places)].map(({ outdated: _, ...n }) => n),
    ...notes.filter((n) => outdated.has(n.id)).map((n) => ({ ...n, outdated: true as const }))
  ].sort(byLine)
}

/** The file a note shows in: the current one first, then the one at the note's path on its side, then the first; -1: none. */
export function noteFileIndex(files: SelectionFile[], note: Pick<ReviewNote, 'side' | 'blob' | 'path'>, current: number): number {
  const shows = (f: SelectionFile | undefined): boolean => f !== undefined && note.blob === noteBlob(f, note.side)
  if (shows(files[current])) return current
  const at = files.findIndex((f) => shows(f) && (note.side === 'new' ? f.path : f.oldPath ?? f.path) === note.path)
  return at >= 0 ? at : files.findIndex(shows)
}

export type NoteTone = 'unsent' | 'waiting' | 'answered' | 'done' | 'resolved'

/** The color of a note's state: done when the agent's last answer confirms the note or fixed it. */
export function noteTone(note: ReviewNote): NoteTone {
  const state = stateOf(note)
  if (state !== 'answered') return state === 'idle' ? 'unsent' : state
  const answer = lastAnswer(note)!
  return answer.verdict === 'confirmed' || answer.fixed ? 'done' : 'answered'
}
