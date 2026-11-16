import { rmSync } from 'node:fs'
import { assert, mountWorker, test } from 'orca/testing'
import { t } from '../shared/i18n.ts'
import { MAX_MESSAGES, stateOf, waitingFor } from '../shared/notes.ts'
import * as main from './main.ts'
import { addNote, deleteNotes, editMessage, listNotes, markSent, markUnsent, noteKey, notesKey, pendingRoots, removeMessage, replyNote, resendNote, resolveNote, setAnswers, type NoteStore } from './notes.ts'
import { draft, fixture, host, memory } from './testkit.ts'

const answer = (review: string, body = 'no') => ({ review, verdict: 'refuted', fixed: false, body, at: 9 }) as const

/** A note of `/r` with its first message, and its id. */
async function added(store: NoteStore): Promise<string> {
  const result = await addNote(store, '/r', draft(), 5)
  assert.ok(result.ok && result.note)
  return result.note.id
}
const stored = async (store: NoteStore, id: string) => (await listNotes(store, '/r')).find((n) => n.id === id)!

test('a note starts as a thread with the user\'s first message', async () => {
  const store = memory()
  const result = await addNote(store, '/r', draft(), 5)
  assert.ok(result.ok && result.note)
  const note = result.note
  assert.match(note.id, /^[0-9a-f]{12}$/)
  assert.deepEqual(note.messages.map((m) => [m.author, m.body, m.at]), [['user', 'why?', 5]])
  assert.equal(stateOf(note), 'unsent')
  assert.deepEqual(await store.get(notesKey('/r')), { root: '/r', ids: [note.id] })
})

test('a stored list of the old shape reads as empty', async () => {
  const store = memory()
  await store.set(notesKey('/r'), { root: '/r', notes: [{ id: 'aaaaaaaaaaaa', body: 'old' }] })
  assert.deepEqual(await listNotes(store, '/r'), [])
  assert.equal((await addNote(store, '/r', draft())).ok, true)
})

test('a name in the list with no note behind it drops out at the next write', async () => {
  const store = memory()
  await store.set(notesKey('/r'), { root: '/r', ids: ['aaaaaaaaaaaa'] })
  assert.deepEqual(await listNotes(store, '/r'), [])
  const id = await added(store)
  assert.deepEqual(await store.get(notesKey('/r')), { root: '/r', ids: [id] })
})

test('a note is stored with a cut quote', async () => {
  const store = memory()
  assert.equal((await addNote(store, '/r', draft({ quote: 'q'.repeat(2500) }), 5)).ok, true)
  const [note] = await listNotes(store, '/r')
  assert.equal(note.quote.length, 2000)
  assert.equal(note.createdAt, 5)
})

test('the states of a thread', async () => {
  const store = memory()
  const id = await added(store)
  await markSent(store, '/r', [id], 'r1')
  assert.equal(stateOf(await stored(store, id)), 'waiting')
  assert.equal(waitingFor(await stored(store, id)), 'r1')
  assert.deepEqual(await pendingRoots(store), ['/r'])
  assert.equal(await setAnswers(store, '/r', new Map([[id, answer('r1')]])), true)
  assert.equal(stateOf(await stored(store, id)), 'answered')
  assert.deepEqual(await pendingRoots(store), [])
  assert.equal((await replyNote(store, '/r', id, 'and this?', undefined)).ok, true)
  assert.equal(stateOf(await stored(store, id)), 'unsent')
  assert.equal((await resolveNote(store, '/r', id, true, 11)).ok, true)
  assert.equal(stateOf(await stored(store, id)), 'resolved')
  assert.equal((await stored(store, id)).resolvedAt, 11)
  assert.equal((await replyNote(store, '/r', id, 'again', undefined)).ok, true)
  const note = await stored(store, id)
  assert.equal(stateOf(note), 'unsent')
  assert.equal(note.resolvedAt, undefined)
})

test('Resolved and Open again', async () => {
  const store = memory()
  const id = await added(store)
  await resolveNote(store, '/r', id, true, 11)
  const opened = await resolveNote(store, '/r', id, false)
  assert.ok(opened.ok && opened.note)
  assert.equal(opened.note.resolvedAt, undefined)
  assert.equal(stateOf(opened.note), 'unsent')
  assert.equal((await resolveNote(store, '/r', id, 'yes')).ok, false)
  assert.equal((await resolveNote(store, '/r', 'nope', true)).ok, false)
})

test('nothing is removed but by a removal', async () => {
  const store = memory()
  const id = await added(store)
  await markSent(store, '/r', [id], 'r1')
  await setAnswers(store, '/r', new Map([[id, answer('r1')]]))
  await replyNote(store, '/r', id, 'and this?', undefined)
  const [first, agent, third] = (await stored(store, id)).messages
  assert.deepEqual([first.author, agent.author, third.author], ['user', 'agent', 'user'])
  const refused = await editMessage(store, '/r', id, first.id, 'changed')
  assert.deepEqual(refused, { ok: false, reason: t('noteSentFixed') })
  const edited = await editMessage(store, '/r', id, third.id, ' changed ')
  assert.ok(edited.ok && edited.note)
  assert.deepEqual(edited.note.messages.map((m) => m.body), ['why?', 'no', 'changed'])
  assert.equal((await editMessage(store, '/r', id, agent.id, 'x')).ok, false)
  assert.equal((await editMessage(store, '/r', id, third.id, '  ')).ok, false)
  assert.equal((await editMessage(store, '/r', id, 'nope', 'x')).ok, false)
  const removed = await removeMessage(store, '/r', id, agent.id)
  assert.ok(removed.ok && removed.note)
  assert.deepEqual(removed.note.messages.map((m) => m.author), ['user', 'user'])
  assert.equal((await removeMessage(store, '/r', id, 'nope')).ok, false)
  await removeMessage(store, '/r', id, first.id)
  assert.deepEqual(await removeMessage(store, '/r', id, third.id), { ok: true, note: null })
  assert.equal(await store.get(noteKey('/r', id)), null)
  assert.deepEqual(await store.get(notesKey('/r')), { root: '/r', ids: [] })
  assert.deepEqual(await listNotes(store, '/r'), [])
})

test('an answer is replaced only when it differs, and only for its own send', async () => {
  const store = memory()
  const id = await added(store)
  await markSent(store, '/r', [id], 'r1')
  assert.equal(await setAnswers(store, '/r', new Map([[id, answer('r1')]])), true)
  const before = (await stored(store, id)).messages[1]
  assert.equal(await setAnswers(store, '/r', new Map([[id, { ...answer('r1'), at: 10 }]])), false)
  assert.equal(await setAnswers(store, '/r', new Map([[id, answer('r1', 'yes, it is')]])), true)
  const after = (await stored(store, id)).messages[1]
  assert.deepEqual([after.id, after.at, after.body], [before.id, before.at, 'yes, it is'])
  // An answer for a send this thread never went out with is not put in.
  assert.equal(await setAnswers(store, '/r', new Map([[id, answer('r9')]])), false)
  await replyNote(store, '/r', id, 'and this?', undefined)
  await markSent(store, '/r', [id], 'r2')
  assert.equal(await setAnswers(store, '/r', new Map([[id, answer('r2', 'second')]])), true)
  const agents = (await stored(store, id)).messages.filter((m) => m.author === 'agent')
  assert.deepEqual(agents.map((m) => [m.review, m.body]), [['r1', 'yes, it is'], ['r2', 'second']])
  assert.equal(agents[0].id, before.id)
})

test('send again takes the mark off the messages nobody answered', async () => {
  const store = memory()
  const id = await added(store)
  const unchanged = await resendNote(store, '/r', id)
  assert.ok(unchanged.ok && unchanged.note)
  assert.equal(stateOf(unchanged.note), 'unsent')
  await markSent(store, '/r', [id], 'r1', 6)
  const resent = await resendNote(store, '/r', id)
  assert.ok(resent.ok && resent.note)
  assert.deepEqual(resent.note.messages.map((m) => [m.review, m.sentAt]), [[undefined, undefined]])
  assert.equal(stateOf(resent.note), 'unsent')
  assert.deepEqual(await pendingRoots(store), [])
})

test('taking a send back unmarks only its messages', async () => {
  const store = memory()
  const a = await added(store)
  const b = await added(store)
  await markSent(store, '/r', [a], 'r1')
  await markSent(store, '/r', [b], 'r2')
  await markUnsent(store, '/r', 'r2')
  assert.deepEqual((await listNotes(store, '/r')).map(waitingFor), ['r1', undefined])
  assert.deepEqual((await stored(store, b)).messages.map((m) => [m.review, m.sentAt]), [[undefined, undefined]])
  assert.deepEqual(await pendingRoots(store), ['/r'])
})

test('the 101st message is refused', async () => {
  const store = memory()
  const id = await added(store)
  for (let i = 1; i < MAX_MESSAGES; i++) assert.equal((await replyNote(store, '/r', id, `m${i}`, undefined)).ok, true)
  assert.deepEqual(await replyNote(store, '/r', id, 'one more', undefined), { ok: false, reason: t('noteFull', { count: MAX_MESSAGES }) })
  assert.equal((await stored(store, id)).messages.length, MAX_MESSAGES)
  assert.equal((await replyNote(store, 'other', id, 'x', undefined)).ok, false)
})

test('a draft that is not a note is refused and nothing is stored', async () => {
  const store = memory()
  for (const bad of [null, draft({ side: 'both' }), draft({ blob: '0'.repeat(40) }), draft({ body: '  ' }), draft({ body: 'b'.repeat(4001) }),
    draft({ start: { line: 2, col: 0 }, end: { line: 2, col: 0 } }), draft({ start: { line: 0, col: 0 } }), draft({ path: '' }),
    draft({ path: 'a.ts\n## Note x' }), draft({ path: 'a\u007f.ts' })]) {
    assert.equal((await addNote(store, '/r', bad)).ok, false)
  }
  assert.deepEqual(await listNotes(store, '/r'), [])
})

test('the 201st note is refused', async () => {
  const store = memory()
  for (let i = 0; i < 200; i++) assert.equal((await addNote(store, '/r', draft())).ok, true)
  assert.equal((await addNote(store, '/r', draft())).ok, false)
  assert.equal((await listNotes(store, '/r')).length, 200)
})

test('a refused write keeps the notes', async () => {
  const store = memory()
  const id = await added(store)
  const set = store.set
  store.set = async () => { throw new Error('value exceeds 262144 bytes') }
  assert.equal((await addNote(store, '/r', draft())).ok, false)
  assert.equal((await replyNote(store, '/r', id, 'more', undefined)).ok, false)
  assert.equal((await listNotes(store, '/r')).length, 1)
  assert.equal((await stored(store, id)).messages.length, 1)
  // The list is refused after the note was written: the note goes too.
  const written: string[] = []
  store.set = async (key, value) => {
    if (key === notesKey('/r')) throw new Error('value exceeds 262144 bytes')
    written.push(key)
    return set(key, value)
  }
  assert.equal((await addNote(store, '/r', draft())).ok, false)
  assert.equal(written.length, 1)
  assert.equal(await store.get(written[0]), null)
  assert.equal((await listNotes(store, '/r')).length, 1)
})

test('a sent mark is all or nothing', async () => {
  const store = memory()
  const a = await added(store)
  const b = await added(store)
  const set = store.set
  store.set = async (key, value) => { if (key === noteKey('/r', b)) throw new Error('value exceeds 262144 bytes'); return set(key, value) }
  await assert.rejects(markSent(store, '/r', [a, b], 'r1'))
  assert.deepEqual((await listNotes(store, '/r')).map(stateOf), ['unsent', 'unsent'])
})

test('deleting notes removes their values', async () => {
  const store = memory()
  const a = await added(store)
  const b = await added(store)
  await markSent(store, '/r', [a], 'r1')
  assert.deepEqual((await deleteNotes(store, '/r', [a, 'nope'])).map((n) => n.id), [a])
  assert.equal(await store.get(noteKey('/r', a)), null)
  assert.deepEqual(await store.get(notesKey('/r')), { root: '/r', ids: [b] })
  assert.deepEqual(await store.get('pending'), [])
  assert.deepEqual(await deleteNotes(store, '/r', 'nope'), [])
})

test('a root is pending from the send to the last answer', async () => {
  const store = memory()
  const a = await added(store)
  const b = await added(store)
  await markSent(store, '/r', [a, b], 'r1')
  assert.deepEqual(await pendingRoots(store), ['/r'])
  await setAnswers(store, '/r', new Map([[a, answer('r1')]]))
  assert.deepEqual(await pendingRoots(store), ['/r'])
  await setAnswers(store, '/r', new Map([[b, answer('r1')]]))
  assert.deepEqual(await pendingRoots(store), [])
})

test('the worker stores a note and tells the frames', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const added = await worker.request('notes.add', { root, draft: draft() })
    assert.ok(added.ok && added.note)
    assert.deepEqual(worker.posts.slice(-1), [{ event: 'notes.changed', payload: { root } }])
    assert.equal((await worker.request('notes.list', { root })).notes.length, 1)
    const id = added.note.id
    const replied = await worker.request('notes.reply', { root, id, body: 'more' })
    assert.ok(replied.ok && replied.note)
    const message = replied.note.messages[1].id
    assert.equal((await worker.request('notes.edit', { root, id, message, body: 'better' })).ok, true)
    assert.equal((await worker.request('notes.resolve', { root, id, resolved: true })).ok, true)
    assert.equal((await worker.request('notes.resend', { root, id })).ok, true)
    assert.equal((await worker.request('notes.remove', { root, id, message })).ok, true)
    const [note] = (await worker.request('notes.list', { root })).notes
    assert.deepEqual(note.messages.map((m) => m.body), ['why?'])
    assert.equal(stateOf(note), 'resolved')
    assert.equal(worker.posts.filter((p) => p.event === 'notes.changed').length, 6)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
