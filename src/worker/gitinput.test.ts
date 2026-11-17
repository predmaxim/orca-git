import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { createGit } from './git.ts'
import { fixture } from './testkit.ts'

test('a git that exits before it reads its input is a failure, not the end of the worker', async () => {
  const root = fixture()
  try {
    // `-c bad` is no config: git exits at once, and the input, larger than a pipe holds, meets a closed pipe.
    const result = await createGit(root).run(['-c', 'bad', 'cat-file', '--batch-check'], { input: 'HEAD\n'.repeat(200_000) })
    assert.equal(result.ok, false)
    assert.match(result.stderr, /bad/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
