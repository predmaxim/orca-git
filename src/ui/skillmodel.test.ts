import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browseDir, skillSuggestions } from './skillmodel.ts'

test('what is typed splits into the folder to browse and the name to match', () => {
  assert.equal(browseDir(''), '')
  assert.equal(browseDir('docs/rev'), 'docs/')
  assert.equal(browseDir('~/.claude/skills/'), '~/.claude/skills/')
  assert.equal(browseDir('/abs'), '/')
})

test('suggestions are the matching .md files, then the matching folders', () => {
  const listing = { dirs: ['Review', 'src'], files: ['README.md', 'rules.md'] }
  assert.deepEqual(skillSuggestions('', listing), ['README.md', 'rules.md', 'Review/', 'src/'])
  assert.deepEqual(skillSuggestions('docs/r', listing), ['docs/README.md', 'docs/rules.md', 'docs/Review/'])
  assert.deepEqual(skillSuggestions('x', listing), [])
})
