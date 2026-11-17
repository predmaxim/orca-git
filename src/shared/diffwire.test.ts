import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileDiff } from './protocol.ts'
import { fromWire, toWire } from './diffwire.ts'

test('a diff comes back from its wire form as it was, an empty line and a hunk without lines included', () => {
  const diff: FileDiff = {
    path: 'a.txt',
    oldPath: 'b.txt',
    binary: false,
    truncated: false,
    oldBlob: 'a'.repeat(40),
    newBlob: 'b'.repeat(40),
    hunks: [
      {
        oldStart: 3,
        newStart: 4,
        section: 'function f()',
        lines: [
          { kind: ' ', text: 'same', old: 3, new: 4 },
          { kind: '-', text: 'gone\r', old: 4 },
          { kind: '+', text: '', new: 5 },
          { kind: '+', text: '+ -', new: 6 },
          { kind: ' ', text: '', old: 5, new: 7 }
        ]
      },
      { oldStart: 1, newStart: 0, section: '', lines: [] }
    ]
  }
  assert.deepEqual(fromWire(toWire(diff)), diff)
})

test('the wire form of a long diff is a few objects, not one per line', () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => ({ kind: '+' as const, text: `line ${i}`, new: i + 1 }))
  const wire = toWire({ path: 'big.txt', binary: false, truncated: false, hunks: [{ oldStart: 0, newStart: 1, section: '', lines }] })
  const objects = (value: unknown): number => (value && typeof value === 'object' ? 1 + Object.values(value).reduce((n: number, v) => n + objects(v), 0) : 0)
  assert.equal(objects(wire), 3)
  assert.equal(fromWire(wire).hunks[0].lines[19_999].new, 20_000)
})
