import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSections, resizePair } from './sections.ts'

const DEFAULTS = {
  collapsed: { branches: false, commits: false, files: false, details: false },
  weights: { branches: 1, commits: 2, files: 1.5, details: 1 }
}

test('normalizeSections fills defaults for missing or broken prefs', () => {
  for (const stored of [undefined, null, 'x', { collapsed: 'x' }, { weights: { commits: -3 } }]) {
    assert.deepEqual(normalizeSections(stored), DEFAULTS)
  }
  const kept = normalizeSections({ collapsed: { files: true, details: 'yes' }, weights: { branches: 0.5, files: 0, details: Infinity } })
  assert.deepEqual(kept.collapsed, { branches: false, commits: false, files: true, details: false })
  assert.deepEqual(kept.weights, { branches: 0.5, commits: 2, files: 1.5, details: 1 })
})

test('normalizeSections keeps one section open when everything was collapsed', () => {
  const all = { branches: true, commits: true, files: true, details: true }
  assert.deepEqual(normalizeSections({ collapsed: all }).collapsed, { ...all, commits: false })
})

test('resizePair moves weight between neighbours and respects the minimum', () => {
  const weights = { branches: 1, commits: 2, files: 2, details: 1 }
  assert.deepEqual(resizePair(weights, 'commits', 'files', 50, 100), { ...weights, commits: 2.5, files: 1.5 })
  const down = resizePair(weights, 'commits', 'files', 1000, 100)
  assert.equal(down.files, 0.48)
  assert.ok(Math.abs(down.commits + down.files - 4) < 1e-9)
  const up = resizePair(weights, 'commits', 'files', -1000, 100)
  assert.equal(up.commits, 0.48)
  assert.deepEqual(weights, { branches: 1, commits: 2, files: 2, details: 1 })
})
