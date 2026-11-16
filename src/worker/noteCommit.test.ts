import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { assert, mountWorker, test } from 'orca/testing'
import { t } from '../shared/i18n.ts'
import type { DiffTabState, NoteSide } from '../shared/protocol.ts'
import { createGit, type Git } from './git.ts'
import * as main from './main.ts'
import { findNoteCommit } from './noteCommit.ts'
import { noteKey, notesKey } from './notes.ts'
import { draft, fixture, host } from './testkit.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A fresh repository: `commit` writes the files given, stages everything and returns the new commit's hash. */
function repo() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-note-commit-')))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  const commit = (message: string, files: Record<string, string> = {}) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
    sh(root, 'add', '-A')
    sh(root, 'commit', '-q', '--allow-empty', '-m', message)
    return sh(root, 'rev-parse', 'HEAD')
  }
  return { git: createGit(root), commit, run: (...args: string[]) => sh(root, ...args), blob: (rev: string, path: string) => sh(root, 'rev-parse', `${rev}:${path}`) }
}

const note = (side: NoteSide, blob: string, rev: string) => ({ side, blob, rev })

test('a new-side note opens the commit that wrote its content', async () => {
  const { git, run, commit, blob } = repo()
  const one = commit('one', { 'a.txt': '1\n' })
  const edit = commit('two', { 'a.txt': '2\n' })
  // git log walks on until it has shown as many commits as -n asks: one search, of one commit.
  const runs: string[][] = []
  const counted: Git = { ...git, run: (args, options) => (runs.push(args), git.run(args, options)) }
  assert.equal(await findNoteCommit(counted, note('new', blob(edit, 'a.txt'), edit)), edit)
  assert.deepEqual(runs.map((args) => args.slice(args.indexOf('-n'), args.indexOf('-n') + 2)), [['-n', '1']])
  // As in readSelectionFiles: under another log output encoding git would print the hashes in it.
  run('config', 'i18n.logOutputEncoding', 'UTF-16')
  assert.equal(await findNoteCommit(git, note('new', blob(edit, 'a.txt'), edit)), edit)
  // As in readSelectionFiles: without --root, log.showRoot=false hides the diff of the commit that wrote the file.
  run('config', 'log.showRoot', 'false')
  assert.equal(await findNoteCommit(git, note('new', blob(one, 'a.txt'), one)), one)
})

test('a rename at the edge of the selection still finds the commit that changed the content', async () => {
  {
    const { git, run, commit, blob } = repo()
    commit('add', { b: 'x\n' })
    const edit = commit('edit', { b: 'y\n' })
    run('mv', 'b', 'c')
    const rename = commit('rename')
    assert.equal(await findNoteCommit(git, note('new', blob(rename, 'c'), rename)), edit)
  }
  {
    const { git, run, commit, blob } = repo()
    const p = commit('add', { a: 'x\n' })
    run('mv', 'a', 'b')
    commit('rename')
    const edit = commit('edit', { b: 'y\n' })
    assert.equal(await findNoteCommit(git, note('old', blob(p, 'a'), p)), edit)
  }
})

test('a merge that keeps its first parent\'s file is not the commit of a note', async () => {
  const { git, run, commit, blob } = repo()
  const p = commit('add', { 'a.txt': '1\n' })
  run('checkout', '-q', '-b', 'side')
  commit('other file', { 'b.txt': 'b\n' })
  run('checkout', '-q', 'main')
  run('merge', '-q', '--no-ff', '-s', 'ours', '--no-edit', 'side')
  const merge = run('rev-parse', 'HEAD')
  const old = note('old', blob(p, 'a.txt'), p)
  assert.equal(await findNoteCommit(git, old), null)
  assert.equal(await findNoteCommit(git, note('new', blob(p, 'a.txt'), merge)), p)
  // An edit on the side branch after the merge: not on HEAD's history, found among the branches.
  run('checkout', '-q', 'side')
  const edit = commit('edit', { 'a.txt': '3\n' })
  run('checkout', '-q', 'main')
  assert.equal(await findNoteCommit(git, old), edit)
})

test('an old-side note opens the oldest descendant of its commit that changes it, not an edit on a branch that forked before', async () => {
  const { git, run, commit, blob } = repo()
  commit('add', { 'f.txt': 'x\n' })
  run('checkout', '-q', '-b', 'side')
  commit('side edit', { 'f.txt': 'z\n' })
  run('checkout', '-q', 'main')
  const p = commit('other file', { 'other.txt': 'o\n' })
  const reviewed = commit('reviewed edit', { 'f.txt': 'y\n' })
  run('merge', '-q', '--no-ff', '-s', 'ours', '--no-edit', 'side')
  const old = note('old', blob(p, 'f.txt'), p)
  // The side edit is on HEAD's history and not an ancestor of p, and git lists it after the reviewed edit: same second, second parent.
  assert.equal(await findNoteCommit(git, old), reviewed)
  // HEAD on the branch that forked before p: none of its commits descends from p, so the branches give the reviewed edit.
  run('checkout', '-q', 'side')
  assert.equal(await findNoteCommit(git, old), reviewed)
  // A newer descendant that changes the same content again: the oldest, the closest to p, is the one.
  run('checkout', '-q', 'main')
  commit('back', { 'f.txt': 'x\n' })
  commit('again', { 'f.txt': 'w\n' })
  assert.equal(await findNoteCommit(git, old), reviewed)
})

test('a note whose content no commit changes has no commit', async () => {
  const { git, commit, blob } = repo()
  const one = commit('one', { 'a.txt': '1\n' })
  commit('two', { 'a.txt': '2\n' })
  for (const side of ['new', 'old'] as const) {
    assert.equal(await findNoteCommit(git, note(side, 'e'.repeat(40), one)), null)
    assert.equal(await findNoteCommit(git, note(side, blob(one, 'a.txt'), 'd'.repeat(40))), null)
  }
  const refused = { root: '/', git: 'git', run: () => assert.fail('git ran'), out: () => assert.fail('git ran') } as unknown as Git
  for (const [b, rev] of [[blob(one, 'a.txt'), '--all'], [blob(one, 'a.txt'), 'HEAD'], ['--all', one], [blob(one, 'a.txt'), one.slice(0, 12)], [blob(one, 'a.txt'), one.toUpperCase()]]) {
    assert.equal(await findNoteCommit(refused, note('new', b, rev)), null)
    assert.equal(await findNoteCommit(refused, note('old', b, rev)), null)
  }
})

test('a git stopped before it answers is an error, not a note without a commit', async () => {
  const stopped = { root: '/', gitPath: 'git', run: async () => ({ ok: false, code: null, stdout: '', stderr: 'git log was stopped' }) } as unknown as Git
  for (const side of ['new', 'old'] as const) await assert.rejects(findNoteCommit(stopped, note(side, 'e'.repeat(40), 'd'.repeat(40))), /git log was stopped/)
})

test('notes.open shows a note in its commit and asks the panel to select that commit', async () => {
  const root = fixture()
  dirs.push(root)
  const [three, two, one] = sh(root, 'rev-list', '-3', 'HEAD').split('\n')
  const { body, ...anchor } = draft({ path: 'two.txt', blob: sh(root, 'rev-parse', `${two}:two.txt`), rev: three })
  const thread = (id: string, over: Record<string, unknown> = {}) => ({ ...anchor, ...over, id, createdAt: 1, messages: [{ id: 'm1', author: 'user', body, at: 1 }] })
  const threads = [thread('aaaaaaaaaaa1'), thread('aaaaaaaaaaa2', { blob: 'e'.repeat(40) })]
  const storage: any = { [notesKey(root)]: { root, ids: threads.map((n) => n.id) }, ...Object.fromEntries(threads.map((n) => [noteKey(root, n.id), n])) }
  const worker = await mountWorker(main, { host: host(root, {}, storage) })

  assert.deepEqual(await worker.request('notes.open', { root, id: 'aaaaaaaaaaa1' }), { ok: true })
  assert.deepEqual(worker.posts.at(-1), { event: 'commit.reveal', payload: { root, hash: two, path: 'two.txt' } })
  const shown = await worker.request('diff.state', { root })
  const state: DiffTabState = {
    root,
    files: [{ status: 'A', path: 'two.txt', from: one, to: two, newBlob: anchor.blob }],
    index: 0,
    open: shown!.open,
    reveal: 'aaaaaaaaaaa1'
  }
  assert.deepEqual(shown, state)

  assert.deepEqual(await worker.request('notes.open', { root, id: 'aaaaaaaaaaa2' }), { ok: false, reason: t('noteCommitMissing') })
  assert.deepEqual(await worker.request('notes.open', { root, id: 'bbbbbbbbbbbb' }), { ok: false, reason: t('noteGone') })
  await worker.deactivate()
})

test('notes.open refuses a note whose commit turns its file into a symlink: a file that changes type has no notes', async () => {
  const root = fixture()
  dirs.push(root)
  const three = sh(root, 'rev-parse', 'HEAD')
  rmSync(join(root, 'three.txt'))
  symlinkSync('one.txt', join(root, 'three.txt'))
  sh(root, 'add', '-A')
  sh(root, 'commit', '-qm', 'link')
  const { body, ...anchor } = draft({ path: 'three.txt', side: 'old', blob: sh(root, 'rev-parse', `${three}:three.txt`), rev: three })
  const thread = { ...anchor, id: 'aaaaaaaaaaa1', createdAt: 1, messages: [{ id: 'm1', author: 'user', body, at: 1 }] }
  const storage: any = { [notesKey(root)]: { root, ids: [thread.id] }, [noteKey(root, thread.id)]: thread }
  const worker = await mountWorker(main, { host: host(root, {}, storage) })
  // The link commit changes the note's content on the old side (`T`), so it is found, and then its file holds no notes.
  assert.equal(await findNoteCommit(createGit(root), anchor), sh(root, 'rev-parse', 'HEAD'))
  assert.deepEqual(await worker.request('notes.open', { root, id: thread.id }), { ok: false, reason: t('noteFileMissing') })
  assert.equal(worker.posts.some((post: any) => post.event === 'commit.reveal'), false)
  await worker.deactivate()
})
