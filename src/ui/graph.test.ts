import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeGraph, graphSvg } from './graph.ts'
import { dayInput, groupByPrefix, reachableFrom, refLabels, relativeDate } from './format.ts'
import { changedRange, changeStarts, splitRows } from './diffmodel.ts'

const row = (hash: string, ...parents: string[]) => ({ hash, parents })

test('a straight history stays in lane 0 with one color', () => {
  const graph = computeGraph([row('c', 'b'), row('b', 'a'), row('a')])
  assert.deepEqual(graph.map((g) => [g.lane, g.color, g.width]), [[0, 0, 1], [0, 0, 1], [0, 0, 1]])
  assert.deepEqual(graph[0].incoming, [])
  assert.deepEqual(graph[1].incoming, [{ lane: 0, color: 0 }])
  assert.deepEqual(graph[2].outgoing, [])
})

test('a merge forks a lane for the second parent and joins it back at the fork point', () => {
  // m merges f (side) into b; both come from a.
  const graph = computeGraph([row('m', 'b', 'f'), row('f', 'a'), row('b', 'a'), row('a')])
  assert.deepEqual(graph[0].outgoing.map((s) => s.lane), [0, 1])
  assert.equal(graph[1].lane, 1)
  assert.deepEqual(graph[1].through.map((s) => s.lane), [0])
  assert.equal(graph[2].lane, 0)
  assert.deepEqual(graph[2].through.map((s) => s.lane), [1])
  assert.equal(graph[3].lane, 0)
  assert.deepEqual(graph[3].incoming.map((s) => s.lane).sort(), [0, 1])
  assert.notEqual(graph[1].color, graph[0].color)
})

test('two branch tips get their own lanes, and freed lanes are reused', () => {
  const graph = computeGraph([row('x', 'a'), row('y', 'a'), row('a', 'r'), row('z', 'r'), row('r')])
  assert.deepEqual(graph.map((g) => g.lane), [0, 1, 0, 1, 0])
  assert.ok(graphSvg(graph[0], { head: true }).includes('class="node head c0"'))
})

test('relative dates', () => {
  const now = new Date(2026, 0, 15, 15, 0).getTime()
  const at = (d: Date) => d.getTime() / 1000
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 14, 59, 40)), now), 'Moments ago')
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 14, 55)), now), '5 minutes ago')
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 13, 30)), now), '1 hour ago')
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 9, 5)), now), 'Today 09:05')
  assert.equal(relativeDate(at(new Date(2026, 0, 14, 22, 1)), now), 'Yesterday 22:01')
})

test('ref labels merge a branch with its remote counterparts', () => {
  const labels = refLabels(['refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/origin/dev', 'refs/tags/v1', 'refs/heads/a'], 'main')
  assert.deepEqual(
    labels.map((l) => [l.kind, l.text, !!l.current]),
    [['local', 'origin & main', true], ['local', 'a', false], ['remote', 'origin/dev', false], ['tag', 'v1', false]]
  )
})

test('reachability follows parents from HEAD', () => {
  const rows = [row('x', 'a'), row('y', 'a'), row('a')].map((r) => ({ ...r, author: '', email: '', authorTime: 0, committer: '', commitTime: 0, subject: '', refs: [] }))
  assert.deepEqual([...reachableFrom('y', rows)].sort(), ['a', 'y'])
})

test('side-by-side rows pair deletions with additions and highlight the changed middle', () => {
  const lines = [
    { kind: ' ' as const, text: 'a', old: 1, new: 1 },
    { kind: '-' as const, text: 'let x = 1', old: 2 },
    { kind: '-' as const, text: 'gone', old: 3 },
    { kind: '+' as const, text: 'let x = 42', new: 2 }
  ]
  const rows = splitRows({ oldStart: 1, newStart: 1, section: '', lines })
  assert.deepEqual(rows, [{ left: lines[0], right: lines[0] }, { left: lines[1], right: lines[3] }, { left: lines[2], right: undefined }])
  assert.deepEqual(changedRange('let x = 1', 'let x = 42'), [8, 9, 10])
  assert.equal(changedRange('abc', 'xyz'), null)
  assert.deepEqual(changeStarts([false, true, true, false, true], Boolean), [1, 4])
})


test('groupByPrefix nests branches by their prefix', () => {
  const ref = (name: string) => ({ name, full: `refs/heads/${name}`, hash: 'a' })
  const tree = groupByPrefix(['fix/ABC-1', 'fix/ABC-2', 'feature/x/y', 'main', 'release-candidate'].map(ref))
  const shape = (nodes: ReturnType<typeof groupByPrefix>): unknown[] =>
    nodes.map((n) => (n.kind === 'folder' ? { [n.path]: shape(n.children) } : n.label))
  assert.deepEqual(shape(tree), [{ feature: [{ 'feature/x': ['y'] }] }, { fix: ['ABC-1', 'ABC-2'] }, 'main', 'release-candidate'])
  const remote = groupByPrefix([ref('origin/a/b')], 'origin')
  assert.deepEqual(shape(remote), [{ a: ['b'] }])
})

test('dayInput shows the day the Date filter picked, east of UTC too', () => {
  const env = process.env
  const zone = env.TZ
  env.TZ = 'Europe/Moscow'
  try {
    // Apply reads the input as local midnight; reopening the filter must show the same day.
    assert.equal(dayInput(new Date('2026-11-05T00:00:00').getTime() / 1000), '2026-11-05')
  } finally {
    if (zone === undefined) delete env.TZ
    else env.TZ = zone
  }
})
