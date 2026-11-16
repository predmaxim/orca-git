import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// node:test's test: orca/testing's re-export is typed without options, and a test here skips on Windows (a #!/bin/sh git).
import { after, test } from 'node:test'
import { assert, mountWorker } from 'orca/testing'
import type { NoteSide, ReviewNote } from '../shared/protocol.ts'
import { createGit } from './git.ts'
import * as main from './main.ts'
import { outdatedAtHead } from './notePlace.ts'
import { noteKey, notesKey } from './notes.ts'
import { notesFile, reviewPaths } from './review.ts'
import { host } from './testkit.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A fresh repository without commits: `commit` writes the files given (null removes one), stages everything and returns the new commit's hash. */
function repo() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-outdated-')))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  const commit = (message: string, files: Record<string, string | null>) => {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) rmSync(join(root, name))
      else writeFileSync(join(root, name), text)
    }
    sh(root, 'add', '-A')
    sh(root, 'commit', '-q', '-m', message)
    return sh(root, 'rev-parse', 'HEAD')
  }
  return { root, git: createGit(root), commit, run: (...args: string[]) => sh(root, ...args), blob: (rev: string, path = 'a.txt') => sh(root, 'rev-parse', `${rev}:${path}`) }
}

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('')
const SIX = ['a', 'b', 'c', 'd', 'e', 'f']

/** A stored note on lines `start..end` of `side` of `path`, in `blob` at `rev`, with a message not sent yet. */
const note = (id: string, side: NoteSide, blob: string, rev: string, start: number, end: number, path = 'a.txt'): ReviewNote => ({
  id, path, side, blob, rev, start: { line: start, col: 0 }, end: { line: end, col: 1 }, quote: 'x', createdAt: 1,
  messages: [{ id: 'm1', author: 'user', body: 'why?', at: 1 }]
})
const outdated = async (git: ReturnType<typeof createGit>, notes: ReviewNote[]) => [...(await outdatedAtHead(git, notes, new Map()))].sort()

test('a note of the history of HEAD whose lines did not change gets no outdated mark', async () => {
  const { git, commit, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX), 'b c.txt': text(...SIX) })
  // Two lines inserted above n1's and a change below them; b c.txt not touched since; n3 written on HEAD itself.
  const b = commit('b', { 'a.txt': text('x', 'y', 'a', 'b', 'c', 'd', 'e', 'F') })
  const notes = [note('n1', 'new', blob(a), a, 3, 4), note('n2', 'new', blob(a, 'b c.txt'), a, 2, 3, 'b c.txt'), note('n3', 'new', blob(b), b, 7, 8)]
  assert.deepEqual(await outdated(git, notes), [])
})

test('a note of the history of HEAD whose lines changed since is outdated', async () => {
  const { git, commit, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  commit('b', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'f') })
  commit('c', { 'other.txt': text('o') })
  assert.deepEqual(await outdated(git, [note('n1', 'new', blob(a), a, 3, 4), note('n2', 'new', blob(a), a, 5, 6)]), ['n1'])
})

test('a note whose file HEAD no longer has is outdated', async () => {
  const { git, commit, blob, run } = repo()
  const a = commit('a', { 'a.txt': text(...SIX), 'b.txt': text(...SIX) })
  commit('b', { 'a.txt': null })
  run('mv', 'b.txt', 'c.txt')
  commit('c', {})
  assert.deepEqual(await outdated(git, [note('n1', 'new', blob(a), a, 1, 1), note('n2', 'new', blob(a, 'b.txt'), a, 1, 1, 'b.txt')]), ['n1', 'n2'])
})

test('a note of another branch gets no outdated mark', async () => {
  const { git, commit, blob, run } = repo()
  commit('a', { 'a.txt': text(...SIX) })
  run('switch', '-q', '-c', 'side')
  const b = commit('b', { 'a.txt': text('x', ...SIX), 'b.txt': text('b') })
  run('switch', '-q', 'main')
  commit('c', { 'a.txt': text('a', 'B', 'c', 'd', 'e', 'f') })
  // HEAD's a.txt differs on the note's lines, and HEAD has no b.txt: neither is a change of the note's code.
  assert.deepEqual(await outdated(git, [note('n1', 'new', blob(b), b, 2, 3), note('n2', 'new', blob(b, 'b.txt'), b, 1, 1, 'b.txt')]), [])
})

test('an old-side note gets no outdated mark', async () => {
  const { git, commit, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  commit('b', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'f') })
  assert.deepEqual(await outdated(git, [note('o1', 'old', blob(a), a, 3, 4)]), [])
})

test('a HEAD without commits marks no note', async () => {
  const { git } = repo()
  assert.deepEqual(await outdated(git, [note('n1', 'new', 'b'.repeat(40), 'c'.repeat(40), 1, 1)]), [])
})

test('notes.list marks the outdated notes and does not store the mark', async () => {
  const { root, commit, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  commit('b', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'f') })
  const changed = note('aaaaaaaaaaa1', 'new', blob(a), a, 3, 4)
  const kept = note('aaaaaaaaaaa2', 'new', blob(a), a, 5, 6)
  const storage: any = { [notesKey(root)]: { root, ids: [changed.id, kept.id] }, [noteKey(root, changed.id)]: changed, [noteKey(root, kept.id)]: kept }
  const h = host(root, {}, storage)
  const worker = await mountWorker(main, { host: h })
  const { notes } = (await worker.request('notes.list', { root })) as { notes: ReviewNote[] }
  assert.deepEqual(notes.map((n) => [n.id, n.outdated]), [[changed.id, true], [kept.id, undefined]])
  assert.equal((h.data().storage as any)[noteKey(root, changed.id)].outdated, undefined)
  await worker.deactivate()
})

test('the notes file tells the agent which notes are outdated', async () => {
  const paths = reviewPaths('/repo', 'bbbbbbbbbbbb')
  const rev = 'c'.repeat(40)
  const notes = [note('aaaaaaaaaaa1', 'new', 'b'.repeat(40), rev, 3, 4), note('aaaaaaaaaaa2', 'new', 'b'.repeat(40), rev, 5, 6)]
  const file = notesFile(notes, paths, [], new Set(['aaaaaaaaaaa1']))
  const line = `Outdated: the code at these lines changed after ${rev}; compare with the current file before acting.`
  assert.match(file, new RegExp(`## Thread aaaaaaaaaaa1\nFile: a.txt\nLines: [^\n]*\n${line.replace(/[.;]/g, '\\$&')}\nSelected:`))
  assert.equal(file.split(line).length, 2)
  assert.equal(notesFile(notes, paths).includes('Outdated:'), false)
})

test('a send writes the outdated mark into the notes file', async () => {
  const { root, commit, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  commit('b', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'f') })
  const changed = note('aaaaaaaaaaa1', 'new', blob(a), a, 3, 4)
  const storage: any = { [notesKey(root)]: { root, ids: [changed.id] }, [noteKey(root, changed.id)]: changed }
  const worker = await mountWorker(main, { host: host(root, { 'agent.launch': { terminalId: 't-1' } }, storage) })
  const sent = (await worker.request('notes.send', { root, ids: [changed.id], agent: 'claude' })) as any
  assert.equal(sent.ok, true)
  assert.match(readFileSync(reviewPaths(root, sent.review).notes, 'utf8'), new RegExp(`\nOutdated: the code at these lines changed after ${a};`))
  await worker.deactivate()
})

test('a message edited while a send compares the notes with HEAD goes to the agent as it is marked sent', { skip: process.platform === 'win32' }, async () => {
  const { root, commit, blob } = repo()
  const a = commit('a', { 'a.txt': text(...SIX) })
  commit('b', { 'a.txt': text('a', 'b', 'C', 'd', 'e', 'f') })
  const changed = note('aaaaaaaaaaa1', 'new', blob(a), a, 3, 4)
  // git's cat-file of the comparison with HEAD waits until the test has saved the edit.
  const started = join(root, '.git', 'compare-started')
  const go = join(root, '.git', 'compare-go')
  const gitPath = join(root, '.git', 'waiting-git')
  writeFileSync(gitPath, `#!/bin/sh\nfor a; do if [ "$a" = --batch-check ]; then touch '${started}'; while [ ! -e '${go}' ]; do sleep 0.01; done; fi; done\nexec git "$@"\n`)
  chmodSync(gitPath, 0o755)
  const storage: any = { [notesKey(root)]: { root, ids: [changed.id] }, [noteKey(root, changed.id)]: changed }
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } }, storage, { gitPath })
  const worker = await mountWorker(main, { host: h })
  try {
    const sending = worker.request('notes.send', { root, ids: [changed.id], agent: 'claude' }) as Promise<any>
    for (let i = 0; i < 1000 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(existsSync(started), true)
    assert.equal(((await worker.request('notes.edit', { root, id: changed.id, message: 'm1', body: 'use Y' })) as any).ok, true)
    writeFileSync(go, '')
    const sent = await sending
    assert.equal(sent.ok, true)
    const stored = (h.data().storage as any)[noteKey(root, changed.id)].messages[0]
    assert.equal(stored.body, 'use Y')
    assert.equal(stored.review, sent.review)
    assert.match(readFileSync(reviewPaths(root, sent.review).notes, 'utf8'), /\n {4}use Y\n/)
  } finally {
    writeFileSync(go, '')
    await worker.deactivate()
  }
})
