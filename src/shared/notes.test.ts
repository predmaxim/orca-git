import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NoteMessage, ReviewNote, SelectionFile } from './protocol.ts'
import { noteBlob, noteFileIndex, notesOfFile, noteTone } from './notes.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const note = (id: string, side: 'old' | 'new', blob: string, line: number, extra: Partial<ReviewNote> = {}): ReviewNote => ({
  id, path: 'src/x.ts', side, blob, rev: 'f'.repeat(40), start: { line, col: 0 }, end: { line, col: 1 }, quote: 'x',
  createdAt: 1, messages: [], ...extra
})
const file = (extra: Partial<SelectionFile> = {}): SelectionFile => ({
  path: 'src/x.ts', status: 'M', from: 'p', to: 't', oldBlob: A, newBlob: B, ...extra
})
const user = (extra: Partial<NoteMessage> = {}): NoteMessage => ({ id: 'u', author: 'user', body: 'q', at: 1, ...extra })
const agent = (extra: Partial<NoteMessage> = {}): NoteMessage => ({ id: 'g', author: 'agent', body: 'a', at: 2, review: 'r1', ...extra })

test('notesOfFile: a note shows on the file whose blob of its side is the note blob', () => {
  const onNew = note('n', 'new', B, 1)
  const onOld = note('o', 'old', A, 2)
  const sideSwapped = note('s', 'old', B, 3)
  const foreign = note('f', 'new', C, 4)
  assert.deepEqual(notesOfFile([onNew, onOld, sideSwapped, foreign], file()).map((n) => n.id), ['n', 'o'])
})

test('notesOfFile: no notes on a file with equal blobs or a type change', () => {
  assert.deepEqual(notesOfFile([note('n', 'new', A, 1)], file({ status: 'R', oldPath: 'src/y.ts', newBlob: A })), [])
  assert.deepEqual(notesOfFile([note('n', 'new', B, 1)], file({ status: 'T' })), [])
})

test('noteBlob: the blob of each side, which the Diff tab ties its cards and new notes to; none on a file with equal blobs or a type change', () => {
  assert.deepEqual([noteBlob(file(), 'old'), noteBlob(file(), 'new')], [A, B])
  assert.deepEqual([noteBlob(file({ status: 'A', oldBlob: undefined }), 'old'), noteBlob(file({ status: 'A', oldBlob: undefined }), 'new')], [undefined, B])
  // A type change: git prints a deletion and an addition, and the tab's diff keeps the first; neither side holds notes.
  for (const side of ['old', 'new'] as const) {
    assert.equal(noteBlob(file({ status: 'T' }), side), undefined)
    assert.equal(noteBlob(file({ status: 'R', oldPath: 'src/y.ts', newBlob: A }), side), undefined)
  }
})

test('notesOfFile: open notes by line, then resolved notes by line', () => {
  const notes = [note('r', 'new', B, 1, { resolvedAt: 5 }), note('9', 'new', B, 9), note('3', 'new', B, 3)]
  assert.deepEqual(notesOfFile(notes, file()).map((n) => n.start.line), [3, 9, 1])
})

test('noteFileIndex: the current file first, then the one at the note path, then the first; -1 when none shows it', () => {
  const files = [file({ path: 'src/a.ts' }), file({ path: 'src/x.ts' }), file({ path: 'src/z.ts' })]
  const onNew = note('n', 'new', B, 1)
  assert.equal(noteFileIndex(files, onNew, 2), 2)
  assert.equal(noteFileIndex(files, onNew, 0), 0)
  assert.equal(noteFileIndex(files, onNew, -1), 1)
  assert.equal(noteFileIndex([files[0], files[2]], onNew, -1), 0)
  assert.equal(noteFileIndex(files, note('f', 'new', C, 1), 1), -1)
  assert.equal(noteFileIndex([file({ path: 'src/a.ts', newBlob: A })], onNew, 0), -1)
})

test('noteFileIndex: an old-side note matches by the old path of a renamed file', () => {
  const files = [file({ path: 'src/x.ts', oldPath: 'src/w.ts', status: 'R' }), file({ path: 'src/y.ts', oldPath: 'src/x.ts', status: 'R' })]
  assert.equal(noteFileIndex(files, note('o', 'old', A, 1), -1), 1)
  assert.equal(noteFileIndex(files, note('n', 'new', B, 1), -1), 0)
})

test('noteTone: each state of a thread', () => {
  const sent = user({ review: 'r1', sentAt: 1 })
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [user()] })), 'unsent')
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [sent] })), 'waiting')
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [sent, agent({ verdict: 'answered' })] })), 'answered')
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [sent, agent({ verdict: 'refuted', fixed: false })] })), 'answered')
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [sent, agent({ verdict: 'confirmed' })] })), 'done')
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [sent, agent({ verdict: 'unclear', fixed: true })] })), 'done')
  assert.equal(noteTone(note('n', 'new', B, 1, { messages: [sent, agent({ verdict: 'confirmed' })], resolvedAt: 9 })), 'resolved')
  assert.equal(noteTone(note('n', 'new', B, 1)), 'unsent')
})
