import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DiffHunk, NoteMessage, ReviewNote } from '../shared/protocol.ts'
import { active, anchor, coveredRange, notesOf, notesText, pickSide, sideLines, unsent } from './notemodel.ts'

const hunks: DiffHunk[] = [
  {
    oldStart: 1,
    newStart: 1,
    section: '',
    lines: [
      { kind: '-', text: 'const a = 1', old: 1 },
      { kind: '+', text: 'const a = 2', new: 1 },
      { kind: ' ', text: '', old: 2, new: 2 },
      { kind: ' ', text: 'export { a }', old: 3, new: 3 }
    ]
  }
]

test('the side comes from where the selection starts', () => {
  assert.equal(pickSide('split', 'left', ' '), 'old')
  assert.equal(pickSide('split', 'right', ' '), 'new')
  assert.equal(pickSide('unified', 'left', '-'), 'old')
  assert.equal(pickSide('unified', 'left', '+'), 'new')
  assert.equal(pickSide('unified', 'left', ' '), 'new')
})
test('a selection inside one line', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'new'), { line: 1, col: 6 }, { line: 1, col: 11 }), { start: { line: 1, col: 6 }, end: { line: 1, col: 11 }, quote: 'a = 2' })
})
test('a reversed selection, and columns past the line', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'new'), { line: 3, col: 99 }, { line: 1, col: 6 }),
    { start: { line: 1, col: 6 }, end: { line: 3, col: 12 }, quote: 'a = 2\n\nexport { a }' })
})
test('a selection that ends at the start of the next line stops at the end of the line before', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'old'), { line: 1, col: 0 }, { line: 2, col: 0 }), { start: { line: 1, col: 0 }, end: { line: 1, col: 11 }, quote: 'const a = 1' })
})
test('points on lines the side lacks move onto it', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'old'), { line: 3, col: 0 }, { line: 9, col: 2 })?.end, { line: 3, col: 12 })
  assert.deepEqual(anchor(sideLines(hunks, 'old'), { line: 0, col: 4 }, { line: 1, col: 5 })?.start, { line: 1, col: 0 })
})
test('nothing selected', () => {
  assert.equal(anchor(sideLines(hunks, 'new'), { line: 1, col: 3 }, { line: 1, col: 3 }), null)
  assert.equal(anchor(new Map(), { line: 1, col: 0 }, { line: 2, col: 4 }), null)
})
test('a note shows where its blob is, on its side only', () => {
  const note = { side: 'new', blob: 'b'.repeat(40) } as ReviewNote
  assert.deepEqual(notesOf([note], { newBlob: 'b'.repeat(40) }), [note])
  assert.deepEqual(notesOf([note], { oldBlob: 'b'.repeat(40) }), [])
})
test('the part of each line a note covers', () => {
  const note = { side: 'new', start: { line: 1, col: 6 }, end: { line: 3, col: 6 } } as ReviewNote
  assert.deepEqual(coveredRange(note, 'new', 1, 11), [6, 11])
  assert.equal(coveredRange(note, 'new', 2, 0), null)
  assert.deepEqual(coveredRange(note, 'new', 3, 12), [0, 6])
  assert.equal(coveredRange(note, 'old', 1, 11), null)
  assert.equal(coveredRange(note, 'new', 4, 5), null)
})
/** A message; a user's one with `review` went out with that send, an agent's one answers it. */
const said = (author: 'user' | 'agent', body: string, review?: string): NoteMessage =>
  ({ id: body, author, body, at: 1, ...(review === undefined ? {} : author === 'user' ? { review, sentAt: 1 } : { review }) })
test('unsent notes are those with a message of the user not sent yet, not waiting for an answer and not resolved', () => {
  const a = { id: 'a', messages: [said('user', 'x', 'r'), said('agent', 'y', 'r'), said('user', 'z')] } as ReviewNote
  const sent = { id: 'b', messages: [said('user', 'x', 'r')] } as ReviewNote
  const waiting = { id: 'c', messages: [said('user', 'x', 'r'), said('user', 'z')] } as ReviewNote
  const resolved = { id: 'd', messages: [said('user', 'x')], resolvedAt: 2 } as ReviewNote
  assert.deepEqual(unsent([a, sent, waiting, resolved]), [a])
})
test('the Notes button counts the threads not resolved', () => {
  const open = { id: 'a', messages: [said('user', 'x', 'r'), said('agent', 'y', 'r')] } as ReviewNote
  const draft = { id: 'b', messages: [said('user', 'x')] } as ReviewNote
  const resolved = { id: 'c', messages: [said('user', 'x', 'r'), said('agent', 'y', 'r')], resolvedAt: 2 } as ReviewNote
  assert.deepEqual(active([open, draft, resolved]), [open, draft])
  assert.deepEqual(unsent([open, draft, resolved]), [draft])
})
test('all threads as markdown: every message under its author, in order', () => {
  const one = { path: 'a.ts', side: 'new', start: { line: 4, col: 0 }, end: { line: 4, col: 3 }, quote: 'foo', messages: [said('user', 'why?', 'r'), said('agent', 'because', 'r')] } as ReviewNote
  const two = { path: 'b.ts', side: 'old', start: { line: 2, col: 0 }, end: { line: 3, col: 1 }, quote: 'x\ny',
    messages: [said('user', 'no', 'r'), { ...said('agent', 'yes', 'r'), agent: 'claude' }, said('user', 'still no')] } as ReviewNote
  assert.equal(notesText([one, two]),
    'a.ts:4 (new)\n> foo\n\n**You:**\nwhy?\n\n**Agent:**\nbecause\n\n---\n\nb.ts:2-3 (old)\n> x\n> y\n\n**You:**\nno\n\n**Agent · claude:**\nyes\n\n**You:**\nstill no')
})
