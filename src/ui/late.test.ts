import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lateResults } from './late.ts'

test('each late result goes to the change whose request timed out, by its id', () => {
  const late = lateResults<string>()
  const a = late.start()
  const b = late.start()
  const got: string[] = []
  assert.equal(late.wait(a, (result) => got.push(`a ${result}`)), true)
  assert.equal(late.wait(b, (result) => got.push(`b ${result}`)), true)
  late.done('of another panel', 'x')
  late.done(b, 'B')
  late.done(a, 'A')
  late.done(a, 'A again')
  assert.deepEqual(got, ['b B', 'a A'])
})

test('a result that came just before its request timed out is used at once; one whose request returned is dropped', () => {
  const late = lateResults<string>()
  const got: string[] = []
  const a = late.start()
  late.done(a, 'A')
  assert.equal(late.wait(a, (result) => got.push(result)), false)
  const b = late.start()
  late.done(b, 'B')
  late.end(b)
  assert.equal(late.wait(b, (result) => got.push(result)), true)
  assert.deepEqual(got, ['A'])
})

test('a worker restart drops every wait: what the old worker ran is never posted', () => {
  const late = lateResults<string>()
  const a = late.start()
  late.wait(a, () => assert.fail('a wait from before the restart ran'))
  assert.equal(late.restart(), true)
  late.done(a, 'A')
  assert.equal(late.restart(), false)
})
