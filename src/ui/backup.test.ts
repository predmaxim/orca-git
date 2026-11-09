import assert from 'node:assert/strict'
import { test } from 'node:test'
import { suggestBackupName } from './backup.ts'

const now = new Date(2026, 10, 10, 9, 5)
const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

test('suggestBackupName stamps the branch, keeps its folders and names a detached HEAD by its hash', () => {
  assert.equal(suggestBackupName('main', hash, new Set(), now), 'backup/main-20261110-0905')
  assert.equal(suggestBackupName('fix/upload-retry', hash, new Set(), now), 'backup/fix/upload-retry-20261110-0905')
  assert.equal(suggestBackupName(null, hash, new Set(), now), 'backup/detached-a1b2c3d4-20261110-0905')
})

test('suggestBackupName counts up past taken names', () => {
  const taken = new Set(['backup/main-20261110-0905', 'backup/main-20261110-0905-2'])
  assert.equal(suggestBackupName('main', hash, taken, now), 'backup/main-20261110-0905-3')
  assert.equal(suggestBackupName('main', hash, new Set(['backup/main-20261110-0905']), now), 'backup/main-20261110-0905-2')
})
