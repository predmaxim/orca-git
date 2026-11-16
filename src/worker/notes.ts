import { createHash, randomBytes } from 'node:crypto'
import { MAX_BODY, MAX_MESSAGES, MAX_NOTES, MAX_QUOTE, waitingFor } from '../shared/notes.ts'
import { t } from '../shared/i18n.ts'
import type { NoteDraft, NoteMessage, NotePoint, NoteResult, ReviewNote } from '../shared/protocol.ts'

/** What `orca.storage` offers. */
export interface NoteStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }

const PENDING = 'pending'
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const hash = (root: string): string => createHash('sha256').update(root).digest('hex')
/** The list of a root's notes, in the order they were made: `{ root, ids }`. */
export const notesKey = (root: string): string => 'notes:' + hash(root)
/** One note of a root, with all its messages. */
export const noteKey = (root: string, id: string): string => 'note:' + hash(root) + ':' + id
const newId = (): string => randomBytes(6).toString('hex')

/** Changes run one at a time: a read-modify-write of two requests must not interleave. */
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

const point = (p: any): NotePoint | null =>
  p && Number.isInteger(p.line) && p.line >= 1 && Number.isInteger(p.col) && p.col >= 0 ? { line: p.line, col: p.col } : null

/** The trimmed text a message of the user may carry, or null. */
const checkBody = (body: unknown): string | null => {
  if (typeof body !== 'string') return null
  const text = body.trim()
  return text.length >= 1 && text.length <= MAX_BODY ? text : null
}

/** The draft as stored, or null; its images are not stored yet. */
export function checkDraft(input: unknown): NoteDraft | null {
  const d = input as any
  if (!d || typeof d !== 'object') return null
  // A control character in the path would forge lines of notes.md.
  if (typeof d.path !== 'string' || d.path.length < 1 || d.path.length > 4096 || /[\x00-\x1f\x7f]/.test(d.path)) return null
  if (d.side !== 'old' && d.side !== 'new') return null
  if (typeof d.blob !== 'string' || !HEX.test(d.blob) || /^0+$/.test(d.blob)) return null
  if (typeof d.rev !== 'string' || !HEX.test(d.rev)) return null
  const start = point(d.start)
  const end = point(d.end)
  if (!start || !end || end.line < start.line || (end.line === start.line && end.col <= start.col)) return null
  if (typeof d.quote !== 'string') return null
  const body = checkBody(d.body)
  if (body === null) return null
  return { path: d.path, side: d.side, blob: d.blob, rev: d.rev, start, end, quote: d.quote.slice(0, MAX_QUOTE), body }
}

/** The notes the list names, in its order; a list of another shape (the unreleased one) is empty, and so is a value no note is in. */
async function read(store: NoteStore, root: string): Promise<ReviewNote[]> {
  const value = (await store.get(notesKey(root))) as { ids?: unknown } | null | undefined
  const ids = Array.isArray(value?.ids) ? value.ids.filter((id): id is string => typeof id === 'string') : []
  const notes = (await Promise.all(ids.map((id) => store.get(noteKey(root, id))))) as any[]
  return notes.filter((n): n is ReviewNote => Array.isArray(n?.messages))
}

/** Writes the list of `root`: the ids of `notes`, so a name of no note drops out of it. */
const writeList = (store: NoteStore, root: string, notes: ReviewNote[]): Promise<void> => store.set(notesKey(root), { root, ids: notes.map((n) => n.id) })

/** Recomputes `pending` for `root` from its notes: pending while one waits for an answer, resolved or not. */
async function syncPending(store: NoteStore, root: string, notes: ReviewNote[]): Promise<void> {
  const next = (await pendingRoots(store)).filter((r) => r !== root)
  if (notes.some((n) => waitingFor(n) !== undefined)) next.push(root)
  await store.set(PENDING, next)
}

const failed = (error: unknown): { ok: false; reason: string } => ({ ok: false, reason: t('notesSaveFailed', { error: error instanceof Error ? error.message : String(error) }) })

export const listNotes = (store: NoteStore, root: string): Promise<ReviewNote[]> => read(store, root)

export function addNote(store: NoteStore, root: string, draft: unknown, now = Date.now()): Promise<NoteResult> {
  return serial(async () => {
    const notes = await read(store, root)
    if (notes.length >= MAX_NOTES) return { ok: false, reason: t('notesFull') }
    const checked = checkDraft(draft)
    if (!checked) return { ok: false, reason: t('noteInvalid') }
    const { body, ...anchor } = checked
    const note: ReviewNote = { ...anchor, id: newId(), createdAt: now, messages: [{ id: newId(), author: 'user', body, at: now }] }
    try {
      await store.set(noteKey(root, note.id), note)
    } catch (error) {
      return failed(error)
    }
    try {
      await writeList(store, root, [...notes, note])
    } catch (error) {
      // A note no list names would only take space.
      await store.delete(noteKey(root, note.id)).catch(() => undefined)
      return failed(error)
    }
    return { ok: true, note }
  })
}

/** Stores what `change` makes of the note `id` of `root`: the note, null to delete it, or the reason it is refused. */
function changeNote(store: NoteStore, root: string, id: unknown, change: (note: ReviewNote) => ReviewNote | null | string): Promise<NoteResult> {
  return serial(async () => {
    const notes = await read(store, root)
    const note = notes.find((n) => n.id === id)
    if (!note) return { ok: false, reason: t('noteMissing') }
    const next = change(note)
    if (typeof next === 'string') return { ok: false, reason: next }
    if (next === note) return { ok: true, note }
    const left = notes.flatMap((n) => (n !== note ? [n] : next ? [next] : []))
    try {
      if (next) await store.set(noteKey(root, note.id), next)
      else {
        await writeList(store, root, left)
        await store.delete(noteKey(root, note.id))
      }
      await syncPending(store, root, left)
    } catch (error) {
      return failed(error)
    }
    return { ok: true, note: next }
  })
}

/** A new message of the user at the end of the thread; it opens a resolved thread again. Its images are not stored yet. */
export function replyNote(store: NoteStore, root: string, id: unknown, body: unknown, _images: unknown, now = Date.now()): Promise<NoteResult> {
  return changeNote(store, root, id, (note) => {
    if (note.messages.length >= MAX_MESSAGES) return t('noteFull', { count: MAX_MESSAGES })
    const text = checkBody(body)
    if (text === null) return t('noteInvalid')
    const { resolvedAt, ...rest } = note
    return { ...rest, messages: [...note.messages, { id: newId(), author: 'user', body: text, at: now }] }
  })
}

/** Changes a message of the user that was not sent: a sent one is what the agent saw. */
export function editMessage(store: NoteStore, root: string, id: unknown, message: unknown, body: unknown): Promise<NoteResult> {
  return changeNote(store, root, id, (note) => {
    const found = note.messages.find((m) => m.id === message)
    if (!found) return t('noteMissing')
    if (found.author !== 'user' || found.sentAt !== undefined) return t('noteSentFixed')
    const text = checkBody(body)
    if (text === null) return t('noteInvalid')
    return { ...note, messages: note.messages.map((m) => (m === found ? { ...m, body: text } : m)) }
  })
}

const unmarked = ({ review, sentAt, ...rest }: NoteMessage): NoteMessage => rest

/** Takes the sent mark off the user's messages of the send the thread waits for; without one the thread stays as it is. */
export function resendNote(store: NoteStore, root: string, id: unknown): Promise<NoteResult> {
  return changeNote(store, root, id, (note) => {
    const review = waitingFor(note)
    if (review === undefined) return note
    return { ...note, messages: note.messages.map((m) => (m.author === 'user' && m.review === review ? unmarked(m) : m)) }
  })
}

/**
 * Removes any message; with the last one the thread goes too. An agent's answer takes its send off the user's messages
 * of it (they stay sent): the thread no longer waits for that send, so its answer file is never read in again.
 */
export function removeMessage(store: NoteStore, root: string, id: unknown, message: unknown): Promise<NoteResult> {
  return changeNote(store, root, id, (note) => {
    const gone = note.messages.find((m) => m.id === message)
    if (!gone) return t('noteMissing')
    const leaveSend = (m: NoteMessage): NoteMessage => {
      if (gone.author !== 'agent' || m.author !== 'user' || m.review === undefined || m.review !== gone.review) return m
      const { review, ...rest } = m
      return rest
    }
    const messages = note.messages.filter((m) => m !== gone).map(leaveSend)
    return messages.length ? { ...note, messages } : null
  })
}

export function resolveNote(store: NoteStore, root: string, id: unknown, resolved: unknown, now = Date.now()): Promise<NoteResult> {
  return changeNote(store, root, id, (note) => {
    if (typeof resolved !== 'boolean') return t('noteInvalid')
    const { resolvedAt, ...rest } = note
    return resolved ? { ...rest, resolvedAt: now } : rest
  })
}

/** Returns the notes it removed. */
export function deleteNotes(store: NoteStore, root: string, ids: unknown): Promise<ReviewNote[]> {
  return serial(async () => {
    if (!Array.isArray(ids)) return []
    const notes = await read(store, root)
    const gone = notes.filter((n) => ids.includes(n.id))
    if (!gone.length) return []
    const left = notes.filter((n) => !gone.includes(n))
    // The list first: a value it no longer names is out of sight even if its delete fails.
    await writeList(store, root, left)
    for (const note of gone) await store.delete(noteKey(root, note.id))
    await syncPending(store, root, left)
    return gone
  })
}

/** Writes the notes `change` returns a new value for, and recomputes `pending`; true if any changed. */
async function changeAll(store: NoteStore, root: string, change: (note: ReviewNote) => ReviewNote): Promise<boolean> {
  const notes = await read(store, root)
  const next = notes.map(change)
  /** The notes written, as they were. */
  const written: ReviewNote[] = []
  try {
    for (const [i, note] of next.entries()) {
      if (note === notes[i]) continue
      await store.set(noteKey(root, note.id), note)
      written.push(notes[i])
    }
  } catch (error) {
    // All or none: a send marked on some notes only would leave them waiting for a folder that is removed.
    for (const note of written) await store.set(noteKey(root, note.id), note).catch(() => undefined)
    throw error
  }
  if (!written.length) return false
  await syncPending(store, root, next)
  return true
}

/** Marks every unsent message of the user in the notes `ids` as gone out with `review`. */
export function markSent(store: NoteStore, root: string, ids: string[], review: string, now = Date.now()): Promise<void> {
  return serial(async () => {
    await changeAll(store, root, (n) =>
      ids.includes(n.id) && n.messages.some((m) => m.author === 'user' && m.sentAt === undefined)
        ? { ...n, messages: n.messages.map((m) => (m.author === 'user' && m.sentAt === undefined ? { ...m, review, sentAt: now } : m)) }
        : n
    )
  })
}

/** Takes the sent mark off the messages of the send `review`: the agent they were sent to did not start. */
export function markUnsent(store: NoteStore, root: string, review: string): Promise<void> {
  return serial(async () => {
    const ours = (m: NoteMessage) => m.author === 'user' && m.review === review
    await changeAll(store, root, (n) => (n.messages.some(ours) ? { ...n, messages: n.messages.map((m) => (ours(m) ? unmarked(m) : m)) } : n))
  })
}

const imageIds = (m: Pick<NoteMessage, 'images'>): string => (m.images ?? []).map((i) => i.id).join()

/** Puts each answer in as the agent's message for its send, or replaces that message when verdict, fixed, body or images differ. */
export function setAnswers(store: NoteStore, root: string, answers: Map<string, Omit<NoteMessage, 'id' | 'author'>>): Promise<boolean> {
  return serial(() =>
    changeAll(store, root, (n) => {
      const answer = answers.get(n.id)
      // An answer for a send the thread did not go out with (taken back since it was read) stays out.
      if (!answer || !n.messages.some((m) => m.author === 'user' && m.review === answer.review)) return n
      const stored = n.messages.find((m) => m.author === 'agent' && m.review === answer.review)
      if (!stored) return { ...n, messages: [...n.messages, { ...answer, id: newId(), author: 'agent' }] }
      // When it was read does not count.
      if (stored.verdict === answer.verdict && stored.fixed === answer.fixed && stored.body === answer.body && imageIds(stored) === imageIds(answer)) return n
      return { ...n, messages: n.messages.map((m) => (m === stored ? { ...answer, id: stored.id, author: 'agent', at: stored.at } : m)) }
    })
  )
}

/** Roots with a thread that waits for an answer. */
export async function pendingRoots(store: NoteStore): Promise<string[]> {
  const value = await store.get(PENDING)
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string') : []
}

/** The most bytes of threads (JSON, UTF-8) `notes.list` answers: Orca refuses a worker's answer over 1 MiB. */
const MAX_LIST_BYTES = 900000

/** The threads a list can carry, in their stored order, and how many are left out: unresolved ones first, then resolved, newest first in each. */
export function fitList(notes: ReviewNote[]): { notes: ReviewNote[]; cut: number } {
  const order = [...notes].sort((a, b) => Number(a.resolvedAt !== undefined) - Number(b.resolvedAt !== undefined) || b.createdAt - a.createdAt)
  const kept = new Set<ReviewNote>()
  let total = 0
  for (const note of order) {
    const bytes = new TextEncoder().encode(JSON.stringify(note)).length
    if (total + bytes > MAX_LIST_BYTES) continue
    total += bytes
    kept.add(note)
  }
  return { notes: notes.filter((n) => kept.has(n)), cut: notes.length - kept.size }
}
