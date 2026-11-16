import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NoteMessage, ReviewNote } from '../shared/protocol.ts'
import { noteTip } from './filetree.ts'

const B = 'b'.repeat(40)
const user = (extra: Partial<NoteMessage> = {}): NoteMessage => ({ id: 'u', author: 'user', body: 'Why here?\nIt runs twice.', at: 1, ...extra })
const agent = (extra: Partial<NoteMessage> = {}): NoteMessage => ({ id: 'g', author: 'agent', body: 'Yes.', at: 2, review: 'r1', ...extra })
const note = (extra: Partial<ReviewNote> = {}): ReviewNote => ({
  id: 'n', path: 'src/x.ts', side: 'new', blob: B, rev: 'f'.repeat(40), start: { line: 3, col: 0 }, end: { line: 5, col: 2 }, quote: 'x',
  createdAt: 1, messages: [user()], ...extra
})
const head = (n: ReviewNote) => noteTip(n).split('\n')[0]

test('noteTip: the path, lines and side of a note and its state, then its first message whole', () => {
  assert.equal(noteTip(note()), 'src/x.ts:3-5 (new) · Not sent\nWhy here?\nIt runs twice.')
  const sent = user({ review: 'r1', sentAt: 1 })
  assert.equal(head(note({ side: 'old', end: { line: 3, col: 4 }, messages: [sent] })), 'src/x.ts:3 (old) · Sent, no answer yet')
  assert.equal(head(note({ messages: [sent, agent({ verdict: 'refuted' })] })), 'src/x.ts:3-5 (new) · Answered')
  assert.equal(head(note({ messages: [sent, agent({ verdict: 'confirmed' })] })), 'src/x.ts:3-5 (new) · Confirmed')
  assert.equal(head(note({ messages: [sent, agent({ verdict: 'unclear', fixed: true })] })), 'src/x.ts:3-5 (new) · Fixed')
  assert.equal(head(note({ messages: [sent, agent({ verdict: 'confirmed' })], resolvedAt: 9 })), 'src/x.ts:3-5 (new) · Resolved')
})
