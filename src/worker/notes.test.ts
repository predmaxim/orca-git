import { rmSync } from 'node:fs'
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { addNote, deleteNotes, listNotes, markSent, notesKey, pendingRoots, setReplies, updateNote } from './notes.ts'
import { draft, fixture, host, memory } from './testkit.ts'

const reply = { verdict: 'confirmed', fixed: true, body: 'done', at: 9 } as const

test('a note is stored with an id and a cut quote', async () => {
  const store = memory()
  const added = await addNote(store, '/r', draft({ quote: 'q'.repeat(2500) }), 5)
  assert.equal(added.ok, true)
  const [note] = await listNotes(store, '/r')
  assert.match(note.id, /^[0-9a-f]{12}$/)
  assert.equal(note.quote.length, 2000)
  assert.equal(note.createdAt, 5)
})

test('a draft that is not a note is refused and nothing is stored', async () => {
  const store = memory()
  for (const bad of [null, draft({ side: 'both' }), draft({ blob: '0'.repeat(40) }), draft({ body: '  ' }), draft({ body: 'b'.repeat(4001) }),
    draft({ start: { line: 2, col: 0 }, end: { line: 2, col: 0 } }), draft({ start: { line: 0, col: 0 } }), draft({ path: '' })]) {
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
  await addNote(store, '/r', draft())
  store.set = async () => { throw new Error('value exceeds 262144 bytes') }
  const second = await addNote(store, '/r', draft())
  assert.equal(second.ok, false)
  assert.equal((await listNotes(store, '/r')).length, 1)
})

test('an edit clears what was sent and answered', async () => {
  const store = memory()
  const added = await addNote(store, '/r', draft())
  assert.ok(added.ok)
  const id = added.note.id
  await markSent(store, '/r', [id], 'rev-1', 6)
  assert.equal(await setReplies(store, '/r', new Map([[id, reply]])), true)
  const edited = await updateNote(store, '/r', id, ' new text ', 7)
  assert.ok(edited.ok)
  const [note] = await listNotes(store, '/r')
  assert.equal(note.body, 'new text')
  assert.equal(note.review, undefined)
  assert.equal(note.sentAt, undefined)
  assert.equal(note.reply, undefined)
  assert.equal(note.updatedAt, 7)
  assert.equal((await updateNote(store, '/r', 'nope', 'x')).ok, false)
})

test('deleting the last note removes the key', async () => {
  const store = memory()
  const added = await addNote(store, '/r', draft())
  assert.ok(added.ok)
  assert.deepEqual((await deleteNotes(store, '/r', [added.note.id])).map((n) => n.id), [added.note.id])
  assert.equal(await store.get(notesKey('/r')), null)
  assert.deepEqual(await store.get('pending'), [])
})

test('a root is pending from the send to the last answer', async () => {
  const store = memory()
  const a = await addNote(store, '/r', draft())
  const b = await addNote(store, '/r', draft())
  assert.ok(a.ok && b.ok)
  await markSent(store, '/r', [a.note.id, b.note.id], 'rev-1')
  assert.deepEqual(await pendingRoots(store), ['/r'])
  await setReplies(store, '/r', new Map([[a.note.id, reply]]))
  assert.deepEqual(await pendingRoots(store), ['/r'])
  await setReplies(store, '/r', new Map([[b.note.id, reply]]))
  assert.deepEqual(await pendingRoots(store), [])
})

test('the worker stores a note and tells the frames', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const added = await worker.request('notes.add', { root, draft: draft() })
    assert.equal(added.ok, true)
    assert.deepEqual(worker.posts.slice(-1), [{ event: 'notes.changed', payload: { root } }])
    assert.equal((await worker.request('notes.list', { root })).notes.length, 1)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
