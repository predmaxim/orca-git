import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SelectionFile } from '../shared/protocol.ts'
import { buildFileTree, orderedFiles } from './filetree.ts'

const file = (path: string): SelectionFile => ({ path, status: 'M', from: 'a', to: 'b' })

test('single-child folders are merged into one row', () => {
  const tree = buildFileTree([file('web/app/scripts/deploy/start.sh'), file('web/app/Dockerfile')])
  assert.equal(tree.length, 1)
  const root = tree[0]
  if (root.kind !== 'dir') throw new Error('expected a folder')
  assert.equal(root.name, 'web/app')
  assert.equal(root.count, 2)
  assert.deepEqual(
    root.children.map((c) => [c.kind, c.name]),
    [
      ['dir', 'scripts/deploy'],
      ['file', 'Dockerfile']
    ]
  )
})

test('folders come before files and both sort by name', () => {
  const tree = buildFileTree([file('b.txt'), file('z/one.txt'), file('z/two.txt'), file('a.txt'), file('m/x.txt'), file('m/y.txt')])
  assert.deepEqual(
    tree.map((n) => n.name),
    ['m', 'z', 'a.txt', 'b.txt']
  )
})

test('orderedFiles follows the drawn order', () => {
  const tree = buildFileTree([file('b.txt'), file('z/two.txt'), file('z/one.txt'), file('a.txt')])
  assert.deepEqual(
    orderedFiles(tree).map((f) => f.path),
    ['z/one.txt', 'z/two.txt', 'a.txt', 'b.txt']
  )
})
