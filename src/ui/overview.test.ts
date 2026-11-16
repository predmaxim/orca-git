import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripSpan } from './overview.ts'

test('a mark is the span of its lines scaled to the strip', () => {
  // A file of 1000 px in a strip of 200 px: a fifth.
  assert.deepEqual(stripSpan(500, 600, 1000, 200, 2), { top: 100, height: 20 })
})

test('a mark at the bottom stays whole inside the strip', () => {
  assert.deepEqual(stripSpan(990, 1000, 1000, 200, 3), { top: 197, height: 3 })
})

test('a mark of one line is at least min high', () => {
  assert.deepEqual(stripSpan(100, 120, 10000, 100, 2), { top: 1, height: 2 })
})

test('nothing to scale by puts the mark at the top', () => {
  assert.deepEqual(stripSpan(0, 0, 0, 300, 3), { top: 0, height: 3 })
})
