import assert from 'node:assert/strict'
import { test } from 'node:test'
import { revealToDo } from './revealonce.ts'

test('the tab scrolls to a note once per opening of the tab', () => {
  const state = { root: '/a', open: 'aaaaaaaaaaaa', reveal: 'abcdef012345' }
  assert.equal(revealToDo({ root: '/a', open: 'aaaaaaaaaaaa' }, null), null)
  assert.equal(revealToDo(state, null), 'abcdef012345')
  assert.equal(revealToDo(state, 'bbbbbbbbbbbb'), 'abcdef012345')
  // The same open read again (diff.show after start, a reload of the frame): done already.
  assert.equal(revealToDo(state, 'aaaaaaaaaaaa'), null)
  // Each repository's tab keeps its own last open: one done in /a does not stop the tab of /b.
  const done = new Map([['/a', 'aaaaaaaaaaaa']])
  assert.equal(revealToDo({ ...state, root: '/b' }, done.get('/b') ?? null), 'abcdef012345')
})
