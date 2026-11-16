import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { assert, mountWorker, test } from 'orca/testing'
import { t } from '../shared/i18n.ts'
import type { NoteSide, ReviewNote } from '../shared/protocol.ts'
import { createGit, timeoutFor } from './git.ts'
import * as main from './main.ts'
import { carryLines, parseHunks, placeNotes } from './notePlace.ts'
import { noteKey, notesKey } from './notes.ts'
import { readSelectionFiles } from './selection.ts'
import { host } from './testkit.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A fresh repository: `commit` writes the files given, stages everything and returns the new commit's hash. */
function repo() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-note-place-')))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  const commit = (message: string, files: Record<string, string>, ...flags: string[]) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
    sh(root, 'add', '-A')
    sh(root, 'commit', '-q', '-m', message, ...flags)
    return sh(root, 'rev-parse', 'HEAD')
  }
  const git = createGit(root)
  /** The files of the selection `hashes` at `path`, as the panel and the Diff tab get them. */
  const files = async (hashes: string[], path = 'a.txt') => (await readSelectionFiles(git, hashes)).filter((f) => f.path === path)
  return { root, git, commit, files, run: (...args: string[]) => sh(root, ...args), blob: (rev: string, path = 'a.txt') => sh(root, 'rev-parse', `${rev}:${path}`) }
}

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('')
const SIX = ['a', 'b', 'c', 'd', 'e', 'f']

/** A stored note on lines `start..end` of `side` of a.txt, in `blob` at `rev`. */
const note = (id: string, side: NoteSide, blob: string, rev: string, start: number, end: number): ReviewNote => ({
  id, path: 'a.txt', side, blob, rev, start: { line: start, col: 0 }, end: { line: end, col: 1 }, quote: 'x', createdAt: 1,
  messages: [{ id: 'm1', author: 'user', body: 'why?', at: 1 }]
})
const at = (id: string, start: number, end: number) => ({ id, start: { line: start, col: 0 }, end: { line: end, col: 1 } })

test('parseHunks reads every hunk header, a count git leaves out being 1', () => {
  assert.deepEqual(parseHunks('@@ -3 +5 @@\n-c\n+C\n'), [[3, 1, 5, 1]])
  assert.deepEqual(parseHunks('@@ -0,0 +1,2 @@\n+x\n+y\n'), [[0, 0, 1, 2]])
  assert.deepEqual(parseHunks('@@ -7,2 +7,0 @@\n-g\n-h\n'), [[7, 2, 7, 0]])
  // A line of the file that reads like a header is a line of a hunk: it starts with its +, - or space.
  const diff = 'diff --git a/1 b/2\nindex 1..2 100644\n--- a/1\n+++ b/2\n@@ -1,0 +2 @@ fn\n+@@ -9 +9 @@\n@@ -4,2 +5,3 @@\n-d\n-e\n+D\n+E\n+F\n@@ -9 +10,0 @@\n-i\n'
  assert.deepEqual(parseHunks(diff), [[1, 0, 2, 1], [4, 2, 5, 3], [9, 1, 10, 0]])
})

test('carryLines moves lines past the hunks above them, and gives null when a hunk touches them', () => {
  // Two lines inserted at the top: 3-4 is 5-6.
  assert.deepEqual(carryLines([[0, 0, 1, 2]], 3, 4), { start: 5, end: 6 })
  // Line 3 changed.
  assert.equal(carryLines([[3, 1, 5, 1]], 3, 4), null)
  // A line inserted between 3 and 4.
  assert.equal(carryLines([[3, 0, 4, 1]], 3, 4), null)
  // A line inserted right after 4: neither inside nor above.
  assert.deepEqual(carryLines([[4, 0, 5, 1]], 3, 4), { start: 3, end: 4 })
  // Lines 1-2 deleted: 5-6 is 3-4.
  assert.deepEqual(carryLines([[1, 2, 1, 0]], 5, 6), { start: 3, end: 4 })
  // A change below moves nothing.
  assert.deepEqual(carryLines([[8, 1, 8, 3]], 3, 4), { start: 3, end: 4 })
})

test('an insertion above moves a note and does not outdate it', async () => {
  const { git, commit, files, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  const b = commit('b', { 'other.txt': text('o') })
  const c = commit('c', { 'a.txt': text('x', 'y', ...SIX) })
  // The selection a..c: the file is added in a, and its new side is c's version.
  assert.deepEqual(await placeNotes(git, [note('n1', 'new', blob(a), a, 3, 4)], await files([a, b, c]), new Map()), [[at('n1', 5, 6)]])
})

test('a new-side note follows a rename in the diff shown', async () => {
  const { git, commit, files, blob, run } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  run('mv', 'a.txt', 'b.txt')
  const c = commit('c', { 'b.txt': text('x', ...SIX) })
  const [file] = await files([c], 'b.txt')
  assert.equal(file.oldPath, 'a.txt')
  assert.deepEqual(await placeNotes(git, [note('n1', 'new', blob(a), a, 3, 4)], [file], new Map()), [[at('n1', 4, 5)]])
})

test('a changed line outdates a new-side note and leaves an old-side note out', async () => {
  const { git, commit, files, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  commit('b', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'f') })
  const c = commit('c', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'F') })
  const notes = [note('n1', 'new', blob(a), a, 3, 4), note('o1', 'old', blob(a), a, 3, 4), note('o2', 'old', blob(a), a, 5, 5)]
  // The file of c: its old side is b's version, where line 3 changed; its new side is c's, where line 3 changed too.
  assert.deepEqual(await placeNotes(git, notes, await files([c]), new Map()), [[{ id: 'n1', outdated: true }, at('o2', 5, 5)]])
})

test('a newer note is not carried to an older version', async () => {
  const { git, commit, files, blob } = repo()
  commit('a', { 'a.txt': text(...SIX) })
  const b = commit('b', { 'a.txt': text('x', ...SIX) })
  const c = commit('c', { 'a.txt': text('x', 'y', ...SIX) })
  // b is an ancestor of c: the version b shows is older than the note.
  assert.deepEqual(await placeNotes(git, [note('n1', 'new', blob(c), c, 3, 4)], await files([b]), new Map()), [[]])
  // merge-base only reads: killed after 60 s like every read.
  assert.equal(timeoutFor(['merge-base', '--is-ancestor', b, c]), 60_000)
})

test('a rewritten commit still carries its notes', async () => {
  const { git, commit, files, blob, run } = repo()
  const x = commit('x', { 'a.txt': text(...SIX) })
  const a = commit('a', { 'a.txt': text('a', 'B', 'c', 'd', 'e', 'f') })
  commit('b', { 'other.txt': text('o') })
  commit('fix', { 'a.txt': text('top', 'a', 'B', 'c', 'd', 'E', 'f') }, `--fixup=${a}`)
  run('-c', 'sequence.editor=:', 'rebase', '-q', '-i', '--autosquash', x)
  const rewritten = run('rev-parse', 'HEAD~1')
  // The note's commit is on no branch any more: not an ancestor of HEAD.
  assert.throws(() => run('merge-base', '--is-ancestor', a, 'HEAD'))
  // n3: a commit git does not know (collected after the rewrite) is carried all the same.
  const notes = [note('n1', 'new', blob(a), a, 3, 4), note('n2', 'new', blob(a), a, 5, 5), note('n3', 'new', blob(a), 'f'.repeat(40), 3, 4)]
  assert.deepEqual(await placeNotes(git, notes, await files([rewritten]), new Map()), [[at('n1', 4, 5), { id: 'n2', outdated: true }, at('n3', 4, 5)]])
})

test('user diff settings do not change the hunks', async () => {
  const { git, commit, files, blob, run } = repo()
  run('config', 'diff.interHunkContext', '3')
  const a = commit('a', { 'a.txt': text(...SIX), '.gitattributes': '* -diff\n' })
  const c = commit('c', { 'a.txt': text('a1', 'a2', 'b', 'c', 'd', 'E', 'f') })
  // As set, git would say the blobs are binary, and with --text merge the two hunks over the note's line 3.
  assert.match(run('diff', '-U0', blob(a), blob(c)), /^Binary files /m)
  assert.equal(run('diff', '-U0', '--text', blob(a), blob(c)).match(/^@@ /gm)?.length, 1)
  assert.deepEqual(await placeNotes(git, [note('n1', 'new', blob(a), a, 3, 3)], await files([c]), new Map()), [[at('n1', 4, 4)]])
})

test('notes.place carries a stored note to the files a frame sends, at most 100 at a time', async () => {
  const { root, commit, files, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  const c = commit('c', { 'a.txt': text('x', 'y', ...SIX) })
  const stored = note('aaaaaaaaaaa1', 'new', blob(a), a, 3, 4)
  const storage: any = { [notesKey(root)]: { root, ids: [stored.id] }, [noteKey(root, stored.id)]: stored }
  const worker = await mountWorker(main, { host: host(root, {}, storage) })
  const [file] = await files([c])
  // A file without candidates (another path) is in the answer too, empty.
  assert.deepEqual(await worker.request('notes.place', { root, files: [file, { ...file, path: 'b.txt' }] }), { places: [[at(stored.id, 5, 6)], []] })
  await assert.rejects(worker.request('notes.place', { root, files: Array(101).fill(file) }), (error: unknown) => String(error).includes(t('notesPlaceTooMany')))
  await worker.deactivate()
})
