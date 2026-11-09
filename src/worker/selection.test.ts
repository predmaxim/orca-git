import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createGit, type Git } from './git.ts'
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

/** `git` whose diff number `slow` (from 0) answers 50 ms late, so the parallel diffs finish in another order. */
function slowDiff(git: Git, slow: number): Git {
  let diffs = 0
  return {
    ...git,
    out: async (args, options) => {
      if (args[0] === 'diff' && diffs++ === slow) await new Promise((resolve) => setTimeout(resolve, 50))
      return git.out(args, options)
    }
  }
}

test('a path listed twice comes out in selection order, whichever diff finishes first', async () => {
  const { root, hashes: h } = repoWith([
    write('a.txt', 'one\ntwo\nthree\nfour\n'),
    (r) => sh(r, 'mv', 'a.txt', 'b.txt'),
    (r) => unlinkSync(join(r, 'b.txt')),
    write('a.txt', 'new\n'),
    write('a.txt', 'new\nmore\n')
  ])
  const git = createGit(root)
  for (const slow of [0, 1]) {
    assert.deepEqual(await readSelectionFiles(slowDiff(git, slow), h.slice(1)), [
      { path: 'a.txt', status: 'D', from: h[0], to: h[2] },
      { path: 'a.txt', status: 'A', from: h[2], to: h[4] }
    ])
  }
})

test('the first failing diff stops the queue: no new git process starts after it', async () => {
  // Each commit adds a file and changes the previous one, so every file has a range, and a diff, of its own.
  const { root, hashes: h } = repoWith(Array.from({ length: 20 }, (_, i) => (r: string) => {
    writeFileSync(join(r, `f${i}.txt`), 'new\n')
    if (i) writeFileSync(join(r, `f${i - 1}.txt`), 'changed\n')
  }))
  const git = createGit(root)
  let diffs = 0
  const failing: Git = {
    ...git,
    out: async (args, options) => {
      if (args[0] !== 'diff') return git.out(args, options)
      if (diffs++ === 0) throw new Error('diff failed')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return git.out(args, options)
    }
  }
  await assert.rejects(readSelectionFiles(failing, h), /diff failed/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(diffs <= 8, `${diffs} diffs ran: the failing one and the seven already running, no more`)
})

test('a long contiguous selection lists each file over the commits that touch it', async () => {
  const steps = Array.from({ length: 30 }, (_, i) => (root: string) => {
    writeFileSync(join(root, `f${i}.txt`), `${i}\n`)
    if (i % 10 === 0) writeFileSync(join(root, 'shared.txt'), `${i}\n`)
  })
  const { root, hashes: h } = repoWith(steps)
  const files = await readSelectionFiles(createGit(root), h.slice(1).reverse())
  assert.deepEqual(files, [
    ...h.slice(1).map((to, i) => ({ path: `f${i + 1}.txt`, status: 'A', from: h[i], to })),
    { path: 'shared.txt', status: 'M', from: h[9], to: h[20] }
  ].sort((a, b) => a.path.localeCompare(b.path)))
})

test('odd file names come through both from the log and from a range diff', async () => {
  const names = ['-rf', ':(glob)*', 'with space.txt', 'юникод.txt', 'tab\there.txt']
  const { root, hashes: h } = repoWith([
    (r) => names.forEach((name) => writeFileSync(join(r, name), '1\n')),
    (r) => names.slice(0, 3).forEach((name) => writeFileSync(join(r, name), '2\n'))
  ])
  const files = await readSelectionFiles(createGit(root), [h[0], h[1]])
  // The first three changed twice (range diff), the last two once (taken from the log).
  assert.deepEqual(files, names.map((path) => ({ path, status: 'A', from: null, to: names.indexOf(path) < 3 ? h[1] : h[0] })).sort((a, b) => a.path.localeCompare(b.path)))
})

test('a path renamed away and added again is listed once', async () => {
  const { root, hashes: h } = repoWith([
    write('a.txt', 'one\ntwo\nthree\nfour\n'),
    (r) => sh(r, 'mv', 'a.txt', 'b.txt'),
    write('a.txt', 'new\n'),
    write('b.txt', 'one\ntwo\nthree\nfour\nfive\n')
  ])
  const files = await readSelectionFiles(createGit(root), [h[1], h[2], h[3]])
  assert.deepEqual(files.map((f) => f.path), ['a.txt', 'b.txt'])
  assert.deepEqual(files[0], { path: 'a.txt', status: 'A', from: h[1], to: h[2] })
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
  for (const bad of [['HEAD'], [], [`--output=${join(root, 'x')}`], [h[0].toUpperCase()], [h[0].slice(0, 39)], 'nope', [h[0], 7]]) {
    await assert.rejects(readSelectionFiles(git, bad as string[]), /Invalid commit selection/)
  }
  await assert.rejects(readSelectionFiles(git, Array(501).fill(h[0])), /Select at most 500 commits/)
  await assert.rejects(readRangeDiff(git, '--x', h[0], 'a'))
})
