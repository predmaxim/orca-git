import assert from 'node:assert/strict'
import { test } from 'node:test'

// api.ts reads globalThis.orca when it is imported, so the stub goes first.
const requests: { name: string; input: Record<string, unknown> }[] = []
;(globalThis as unknown as { orca: unknown }).orca = {
  locale: 'en',
  plugin: { request: async (name: string, input: Record<string, unknown>) => { requests.push({ name, input }) } }
}
const { api } = await import('./api.ts')

const last = () => requests[requests.length - 1].input
// Orca checks a request's input with z.json(), which refuses an undefined value at any depth.
const isJson = (input: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(input)), input)

test('a send without an agent has no agent key', async () => {
  await api.notesSend('/r', ['a'])
  assert.equal('agent' in last(), false)
  assert.deepEqual(last(), { root: '/r', ids: ['a'], locale: 'en' })
  isJson(last())
})

test('a send to a named agent keeps it', async () => {
  await api.notesSend('/r', ['a'], 'claude')
  assert.equal(last().agent, 'claude')
  isJson(last())
})

test('a reply without images has no images key', async () => {
  await api.noteReply('/r', 't', 'text')
  assert.equal('images' in last(), false)
  isJson(last())
})

test('a draft with undefined images has no images key', async () => {
  await api.noteAdd('/r', { path: 'a.ts', body: 'x', images: undefined } as unknown as Parameters<typeof api.noteAdd>[1])
  assert.equal('images' in (last().draft as object), false)
  isJson(last())
})

test('notes.place carries the files as they are, without the undefined old path', async () => {
  const file = { path: 'a.ts', oldPath: undefined, status: 'M', from: 'p', to: 't', oldBlob: 'o', newBlob: 'n' }
  await api.notesPlace('/r', [file])
  assert.equal(requests[requests.length - 1].name, 'notes.place')
  assert.deepEqual(last(), { root: '/r', files: [{ path: 'a.ts', status: 'M', from: 'p', to: 't', oldBlob: 'o', newBlob: 'n' }], locale: 'en' })
  isJson(last())
})
