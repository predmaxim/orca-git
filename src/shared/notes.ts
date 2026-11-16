import type { NoteMessage, ReviewNote } from './protocol.ts'

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
