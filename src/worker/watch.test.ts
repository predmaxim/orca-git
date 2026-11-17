import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRelevant } from './watch.ts'

test('a ref, HEAD or a stopped operation is a change to the log, an index is not, in a linked worktree either', () => {
  for (const path of ['HEAD', 'refs/heads/main', 'packed-refs', 'rebase-merge/done', 'worktrees/wt/HEAD', 'worktrees/wt/rebase-merge', 'worktrees/wt/MERGE_HEAD']) assert.equal(isRelevant(path), true, path)
  for (const path of ['index', 'worktrees/wt/index', 'worktrees/wt/logs/HEAD', 'refs/heads/main.lock', 'worktrees/wt/HEAD.lock', 'objects/ab/cdef', 'worktrees']) assert.equal(isRelevant(path), false, path)
  // The name alone (no path from the watcher): read everything again.
  assert.equal(isRelevant(null), true)
})
