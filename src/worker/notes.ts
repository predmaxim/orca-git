import { createHash, randomBytes } from 'node:crypto'
import { MAX_BODY, MAX_NOTES, MAX_QUOTE } from '../shared/notes.ts'
import { t } from '../shared/i18n.ts'
import type { NoteDraft, NotePoint, NoteReply, NoteResult, ReviewNote } from '../shared/protocol.ts'

/** What `orca.storage` offers. */
export interface NoteStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }

const PENDING = 'pending'
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const notesKey = (root: string): string => 'notes:' + createHash('sha256').update(root).digest('hex')

/** Changes run one at a time: a read-modify-write of two requests must not interleave. */
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

const point = (p: any): NotePoint | null =>
  p && Number.isInteger(p.line) && p.line >= 1 && Number.isInteger(p.col) && p.col >= 0 ? { line: p.line, col: p.col } : null

/** The trimmed text a note may carry, or null. */
const checkBody = (body: unknown): string | null => {
  if (typeof body !== 'string') return null
  const text = body.trim()
  return text.length >= 1 && text.length <= MAX_BODY ? text : null
}

export function checkDraft(input: unknown): NoteDraft | null {
  const d = input as any
  if (!d || typeof d !== 'object') return null
  if (typeof d.path !== 'string' || d.path.length < 1 || d.path.length > 4096) return null
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

async function read(store: NoteStore, root: string): Promise<ReviewNote[]> {
  const value = (await store.get(notesKey(root))) as { notes?: unknown } | null | undefined
  return Array.isArray(value?.notes) ? (value.notes as ReviewNote[]) : []
}

/** Writes the notes of `root` (the key goes with the last note) and recomputes `pending` for it. */
async function write(store: NoteStore, root: string, notes: ReviewNote[]): Promise<void> {
  if (notes.length) await store.set(notesKey(root), { root, notes })
  else await store.delete(notesKey(root))
  const next = (await pendingRoots(store)).filter((r) => r !== root)
  if (notes.some((n) => n.review && !n.reply)) next.push(root)
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
    const note: ReviewNote = { ...checked, id: randomBytes(6).toString('hex'), createdAt: now }
    try { await write(store, root, [...notes, note]) } catch (error) { return failed(error) }
    return { ok: true, note }
  })
}

export function updateNote(store: NoteStore, root: string, id: unknown, body: unknown, now = Date.now()): Promise<NoteResult> {
  return serial(async () => {
    const notes = await read(store, root)
    const at = notes.findIndex((n) => n.id === id)
    if (at < 0) return { ok: false, reason: t('noteMissing') }
    const text = checkBody(body)
    if (text === null) return { ok: false, reason: t('noteInvalid') }
    const { review, sentAt, reply, ...rest } = notes[at]
    const note: ReviewNote = { ...rest, body: text, updatedAt: now }
    try { await write(store, root, notes.map((n, i) => (i === at ? note : n))) } catch (error) { return failed(error) }
    return { ok: true, note }
  })
}

/** Returns the notes it removed. */
export function deleteNotes(store: NoteStore, root: string, ids: unknown): Promise<ReviewNote[]> {
  return serial(async () => {
    if (!Array.isArray(ids)) return []
    const notes = await read(store, root)
    const gone = notes.filter((n) => ids.includes(n.id))
    if (gone.length) await write(store, root, notes.filter((n) => !gone.includes(n)))
    return gone
  })
}

export function markSent(store: NoteStore, root: string, ids: string[], review: string, now = Date.now()): Promise<void> {
  return serial(async () => {
    const notes = await read(store, root)
    await write(store, root, notes.map((n) => (ids.includes(n.id) ? { ...n, review, sentAt: now } : n)))
  })
}

/** Stores the answers by note id; true if any note changed. */
export function setReplies(store: NoteStore, root: string, replies: Map<string, NoteReply>): Promise<boolean> {
  return serial(async () => {
    const notes = await read(store, root)
    let changed = false
    const next = notes.map((n) => {
      const reply = replies.get(n.id)
      if (!reply || !n.review || JSON.stringify(n.reply) === JSON.stringify(reply)) return n
      changed = true
      return { ...n, reply }
    })
    if (changed) await write(store, root, next)
    return changed
  })
}

/** Roots with a note that was sent and not answered yet. */
export async function pendingRoots(store: NoteStore): Promise<string[]> {
  const value = await store.get(PENDING)
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string') : []
}
