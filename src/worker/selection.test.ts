import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createGit } from './git.ts'
import { readRangeDiff, readSelectionFiles } from './selection.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Runs each step in a fresh repository; a step returning true commits the work as `cN`. Returns the root and hashes. */
function repoWith(steps: Array<(root: string) => void>): { root: string; hashes: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'git-log-selection-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  const hashes: string[] = []
  steps.forEach((step, i) => {
    step(root)
    sh(root, 'add', '-A')
    sh(root, 'commit', '-q', '-m', `c${i + 1}`)
    hashes.push(sh(root, 'rev-parse', 'HEAD'))
  })
  return { root, hashes }
}

const write = (name: string, text: string) => (root: string) => writeFileSync(join(root, name), text)

test('a contiguous selection lists each added file from its own parent', async () => {
  const { root, hashes: h } = repoWith([1, 2, 3, 4].map((i) => write(`f${i}.txt`, `${i}\n`)))
  const files = await readSelectionFiles(createGit(root), [h[3], h[1], h[2]])
  assert.deepEqual(files, [
    { path: 'f2.txt', status: 'A', from: h[0], to: h[1] },
    { path: 'f3.txt', status: 'A', from: h[1], to: h[2] },
    { path: 'f4.txt', status: 'A', from: h[2], to: h[3] }
  ])
})

test('a gap in the selection folds the unselected change in, like WebStorm', async () => {
  const { root, hashes: h } = repoWith([1, 2, 3, 4].map((i) => write('a.txt', `${i}\n`)))
  const git = createGit(root)
  const files = await readSelectionFiles(git, [h[1], h[3]])
  assert.deepEqual(files, [{ path: 'a.txt', status: 'M', from: h[0], to: h[3] }])
  const diff = await readRangeDiff(git, h[0], h[3], 'a.txt')
  const lines = diff.hunks.flatMap((hunk) => hunk.lines.map((l) => `${l.kind}${l.text}`))
  assert.ok(lines.includes('-1'))
  assert.ok(lines.includes('+4'))
})

test('a file added and deleted inside the selection is left out', async () => {
  const { root, hashes: h } = repoWith([
    write('base.txt', 'b\n'),
    write('tmp.txt', 't\n'),
    (r) => unlinkSync(join(r, 'tmp.txt'))
  ])
  const files = await readSelectionFiles(createGit(root), [h[1], h[2]])
  assert.deepEqual(files, [])
})

test('a rename followed by an edit is one renamed file', async () => {
  const { root, hashes: h } = repoWith([
    write('a.txt', 'one\ntwo\nthree\nfour\n'),
    (r) => sh(r, 'mv', 'a.txt', 'b.txt'),
    write('b.txt', 'one\ntwo\nthree\nfour\nfive\n')
  ])
  const files = await readSelectionFiles(createGit(root), [h[1], h[2]])
  assert.deepEqual(files, [{ path: 'b.txt', status: 'R', oldPath: 'a.txt', from: h[0], to: h[2] }])
})

test('a rename followed by a delete reports the original file as deleted', async () => {
  const { root, hashes: h } = repoWith([
    write('a.txt', 'one\ntwo\nthree\nfour\n'),
    (r) => sh(r, 'mv', 'a.txt', 'b.txt'),
    (r) => unlinkSync(join(r, 'b.txt')),
    write('other.txt', 'x\n')
  ])
  const files = await readSelectionFiles(createGit(root), [h[1], h[2]])
  assert.deepEqual(files, [{ path: 'a.txt', status: 'D', from: h[0], to: h[2] }])
})

test('the root commit diffs against the empty tree, even with log.showRoot off', async () => {
  const { root, hashes: h } = repoWith([write('f1.txt', '1\n')])
  sh(root, 'config', 'log.showRoot', 'false')
  const git = createGit(root)
  assert.deepEqual(await readSelectionFiles(git, [h[0]]), [{ path: 'f1.txt', status: 'A', from: null, to: h[0] }])
  const diff = await readRangeDiff(git, null, h[0], 'f1.txt')
  assert.deepEqual(diff.hunks[0].lines[0], { kind: '+', text: '1', new: 1 })
})

test("selection spanning a merge lists the merge's first-parent changes and the side commit's", async () => {
  const { root, hashes } = repoWith([write('m0.txt', '0\n')])
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(root, 's.txt'), 's\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 's1')
  const s1 = sh(root, 'rev-parse', 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  writeFileSync(join(root, 'm.txt'), 'm\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'm2')
  sh(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'side')
  const merge = sh(root, 'rev-parse', 'HEAD')
  assert.deepEqual(await readSelectionFiles(git, [merge]), [{ path: 's.txt', status: 'A', from: sh(root, 'rev-parse', `${merge}^1`), to: merge }])
  const both = await readSelectionFiles(git, [merge, s1])
  assert.equal(both.filter((f) => f.path === 's.txt').length, 1)
  assert.deepEqual(both.find((f) => f.path === 's.txt'), { path: 's.txt', status: 'A', from: hashes[0], to: merge })
})

test('invalid hashes are refused', async () => {
  const { root, hashes: h } = repoWith([write('a.txt', '1\n')])
  const git = createGit(root)
  await assert.rejects(readSelectionFiles(git, ['HEAD']))
  await assert.rejects(readRangeDiff(git, '--x', h[0], 'a'))
})
