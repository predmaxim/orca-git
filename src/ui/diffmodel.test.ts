import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeBlocks } from './diffmodel.ts'

const ctx = { add: false, del: false }
const add = { add: true, del: false }
const del = { add: false, del: true }
const both = { add: true, del: true }

test('a block of changes is added, deleted or modified by the lines in it', () => {
  assert.deepEqual(changeBlocks([add, add]), [{ start: 0, end: 1, kind: 'added' }])
  assert.deepEqual(changeBlocks([del]), [{ start: 0, end: 0, kind: 'deleted' }])
  assert.deepEqual(changeBlocks([del, add]), [{ start: 0, end: 1, kind: 'modified' }])
  // A side-by-side row with both sides changed.
  assert.deepEqual(changeBlocks([ctx, both, ctx]), [{ start: 1, end: 1, kind: 'modified' }])
})

test('context between changes makes two blocks; no rows make none', () => {
  assert.deepEqual(changeBlocks([ctx, add, ctx, ctx, del, del]), [
    { start: 1, end: 1, kind: 'added' },
    { start: 4, end: 5, kind: 'deleted' }
  ])
  assert.deepEqual(changeBlocks([]), [])
  assert.deepEqual(changeBlocks([ctx, ctx]), [])
})
