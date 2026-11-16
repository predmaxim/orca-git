import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SelectionFile } from '../shared/protocol.ts'

// api.ts reads globalThis.orca when it is imported, so the stub goes first.
const requests: { name: string; input: Record<string, unknown> }[] = []
;(globalThis as unknown as { orca: unknown }).orca = {
  locale: 'en',
  plugin: { request: async (name: string, input: Record<string, unknown>) => { requests.push({ name, input }) } }
}
const { api } = await import('./api.ts')

const file: SelectionFile = { status: 'M', path: 'a.ts', from: 'f', to: 't' }

test('a note the tab does not show is opened by its id', async () => {
  await api.notesOpen('/r', 'abcdef012345')
  assert.deepEqual(requests.pop(), { name: 'notes.open', input: { root: '/r', id: 'abcdef012345', locale: 'en' } })
})

test('a file opens with the note to scroll to, and without a note key when there is none', async () => {
  await api.openDiff('/r', ['h'], file, 'abcdef012345')
  assert.deepEqual(requests.pop(), { name: 'diff.open', input: { root: '/r', hashes: ['h'], path: 'a.ts', to: 't', note: 'abcdef012345', locale: 'en' } })
  await api.openDiff('/r', ['h'], file)
  assert.deepEqual(requests.pop(), { name: 'diff.open', input: { root: '/r', hashes: ['h'], path: 'a.ts', to: 't', locale: 'en' } })
})
