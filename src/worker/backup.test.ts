import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ActionResult } from '../shared/protocol.ts'
import { runAction } from './actions.ts'
import { checkBackup, checkReset, createBackup, deleteBackup, runGuarded } from './backup.ts'
import { runBranchAction } from './branchActions.ts'
import { createGit, type Git } from './git.ts'

const dirs: string[] = []
const [major, minor] = (execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
/** `git init --ref-format` came in git 2.45 with reftable; older git has only the files backend. */
const filesBackend = major > 2 || (major === 2 && minor >= 45) ? ['--ref-format=files'] : []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** main with c1..c4, one file each; `init` adds options to git init. */
function repo(...init: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'git-log-backup-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main', ...init)
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  for (const name of ['c1', 'c2', 'c3', 'c4']) commit(root, `${name}.txt`, `${name}\n`, name)
  return root
}

function commit(root: string, file: string, text: string, message: string): void {
  writeFileSync(join(root, file), text)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', message)
}

const rev = (root: string, name: string) => sh(root, 'rev-parse', name)
const refs = (root: string) => sh(root, 'for-each-ref', '--format=%(refname) %(objectname)')
const reachable = (root: string, hash: string, from: string) => {
  try {
    sh(root, 'merge-base', '--is-ancestor', hash, from)
    return true
  } catch {
    return false
  }
}

const NAME = 'backup/main-20261110-1432'

for (const kind of ['branch', 'tag'] as const) {
  test(`a ${kind} backup points at the old tip and keeps the dropped commits`, async () => {
    const root = repo()
    const git = createGit(root)
    const head = rev(root, 'HEAD')
    const [c3, c2] = [rev(root, 'HEAD~1'), rev(root, 'HEAD~2')]
    const result = await runGuarded(git, { expectHead: head, backup: { kind, name: NAME, target: head } }, 'HEAD', () =>
      runAction(git, { kind: 'drop', hashes: [c3, c2] })
    )
    assert.equal(result.ok, true, result.message)
    assert.equal(result.backup, NAME)
    assert.equal(result.head, rev(root, 'HEAD'))
    const ref = kind === 'branch' ? `refs/heads/${NAME}` : `refs/tags/${NAME}`
    assert.equal(rev(root, ref), head)
    assert.ok(reachable(root, c2, ref) && reachable(root, c3, ref))
    assert.ok(!reachable(root, c2, 'main') && !reachable(root, c3, 'main'))
    assert.doesNotMatch(sh(root, 'config', '--list'), /^branch\.backup/m)
  })
}

test('a taken name refuses the backup and the action does not run', async () => {
  const root = repo()
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  sh(root, 'branch', NAME, 'HEAD~3')
  const before = refs(root)
  const result = await runGuarded(git, { backup: { kind: 'branch', name: NAME, target: head } }, 'HEAD', () =>
    runAction(git, { kind: 'drop', hashes: [rev(root, 'HEAD~1')] })
  )
  assert.deepEqual([result.ok, result.message], [false, `${NAME} already exists. Nothing was done.`])
  assert.equal(refs(root), before)
})

test('hostile names and targets are refused before git runs', async () => {
  const root = repo()
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  const before = refs(root)
  const bad: unknown[] = [
    ...['-x', 'a..b', 'a b', 'a@{1}', '', 'refs/heads/../x', 'refs/heads/x', 'refs/tags/x'].flatMap((name) => [
      { kind: 'branch', name, target: head },
      { kind: 'tag', name, target: head }
    ]),
    { kind: 'branch', name: 'backup/ok', target: 'HEAD' },
    { kind: 'branch', name: 'backup/ok', target: 'abc' },
    { kind: 'branch', name: 'backup/ok', target: `${head}\n` },
    { kind: 'remote', name: 'backup/ok', target: head },
    { kind: 'branch', name: 42, target: head },
    null
  ]
  for (const request of bad) {
    const result = await createBackup(git, request)
    assert.equal(result.ok, false, JSON.stringify(request))
  }
  assert.equal(refs(root), before)
})

test('reset --hard with stash keeps the uncommitted changes in the stash', async () => {
  const root = repo()
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  writeFileSync(join(root, 'c4.txt'), 'local edit\n')
  const result = await runGuarded(
    git,
    { expectHead: head, backup: { kind: 'branch', name: NAME, target: head, stash: true } },
    'HEAD',
    () => runAction(git, { kind: 'reset', hash: rev(root, 'HEAD~2'), mode: 'hard' }),
    true
  )
  assert.equal(result.ok, true, result.message)
  assert.match(result.stash ?? '', /^[0-9a-f]{40}$/)
  assert.equal(rev(root, 'stash@{0}'), result.stash)
  assert.match(sh(root, 'stash', 'show', '-p', 'stash@{0}'), /\+local edit/)
  assert.match(sh(root, 'stash', 'list'), /Git plugin backup before reset --hard \(main\)/)
  assert.equal(sh(root, 'status', '--porcelain'), '')
  assert.equal(rev(root, `refs/heads/${NAME}`), head)
})

test('a stash is refused unless the action is a hard reset', async () => {
  const root = repo()
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  writeFileSync(join(root, 'c4.txt'), 'local edit\n')
  const before = refs(root)
  let ran = false
  const result = await runGuarded(git, { backup: { kind: 'branch', name: NAME, target: head, stash: true } }, 'HEAD', async () => {
    ran = true
    return { ok: true, message: 'ran' }
  })
  assert.equal(result.ok, false)
  assert.equal(ran, false)
  assert.equal(refs(root), before)
})

test('a stash that cannot be stored names the backup already made, and the action does not run', async () => {
  // The lock below blocks only the files ref backend, whatever git's default is.
  const root = repo(...filesBackend)
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  writeFileSync(join(root, 'c4.txt'), 'local edit\n')
  // A stale lock makes git stash store fail after the backup branch exists.
  writeFileSync(join(root, '.git', 'refs', 'stash.lock'), '')
  let ran = false
  const run = async (): Promise<ActionResult> => {
    ran = true
    return { ok: true, message: 'ran' }
  }
  const result = await runGuarded(git, { expectHead: head, backup: { kind: 'branch', name: NAME, target: head, stash: true } }, 'HEAD', run, true)
  assert.equal(result.ok, false)
  assert.ok(result.message.includes(NAME), result.message)
  assert.equal(result.backup, NAME)
  assert.equal(ran, false)
  assert.equal(rev(root, `refs/heads/${NAME}`), head)
  assert.equal(readFileSync(join(root, 'c4.txt'), 'utf8'), 'local edit\n')
})

test('the backup name check refuses what git would refuse, taken names and folder clashes', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'branch', 'backup/main')
  sh(root, 'branch', 'backup/x/y')
  sh(root, 'tag', 'backup/t')
  const refused: [unknown, unknown][] = [
    ['branch', 'a b'],
    ['branch', 'a..b'],
    ['branch', 'x.lock'],
    ['branch', `backup/${'x'.repeat(250)}`],
    ['branch', 'backup/main'],
    ['branch', 'backup/main/old'],
    ['branch', 'backup/x'],
    ['tag', 'backup/t'],
    ['branch', 'refs/heads/x'],
    ['tag', 'refs/tags/x'],
    ['remote', 'backup/ok'],
    ['branch', 42]
  ]
  for (const [kind, name] of refused) {
    const result = await checkBackup(git, kind, name)
    assert.equal(result.ok, false, `${kind} ${name}`)
    assert.ok(!result.ok && result.reason, `${kind} ${name}`)
  }
  // Only refs of the same kind clash: the dialog keeps branch and tag names apart itself.
  assert.deepEqual(await checkBackup(git, 'branch', 'backup/t'), { ok: true })
  assert.deepEqual(await checkBackup(git, 'tag', 'backup/main'), { ok: true })
  assert.deepEqual(await checkBackup(git, 'branch', 'backup/main-2'), { ok: true })
})

test('the reset check reports a dirty tree and the untracked or ignored files the target would overwrite', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  commit(root, 'new.txt', 'theirs\n', 'add new.txt')
  commit(root, 'build.out', 'theirs\n', 'add build.out')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  writeFileSync(join(root, '.gitignore'), '*.out\n')
  for (const file of ['new.txt', 'build.out', 'stray.txt']) writeFileSync(join(root, file), 'mine\n')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['build.out', 'new.txt'], repositories: [] })
  writeFileSync(join(root, 'c1.txt'), 'edited\n')
  assert.deepEqual(await checkReset(git, root, target), { dirty: true, overwritten: ['build.out', 'new.txt'], repositories: [] })
  assert.deepEqual(await checkReset(git, root, rev(root, 'HEAD~1')), { dirty: true, overwritten: [], repositories: [] })
  await assert.rejects(checkReset(git, root, 'HEAD'))
})

test('the reset check lists an untracked file standing where the target needs a folder', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  mkdirSync(join(root, 'build'))
  commit(root, 'build/x', 'theirs\n', 'add build/x')
  mkdirSync(join(root, 'gen'))
  commit(root, 'gen/y', 'theirs\n', 'add gen/y')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  // A file named like the target's folder is replaced by it; a file of mine inside an untracked folder is not.
  writeFileSync(join(root, 'build'), 'mine\n')
  mkdirSync(join(root, 'gen'))
  writeFileSync(join(root, 'gen', 'z'), 'mine\n')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['build'], repositories: [] })
})

test('the reset check looks inside untracked nested repositories, which git does not list', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  mkdirSync(join(root, 'nested'))
  commit(root, 'nested/x', 'theirs\n', 'add nested/x')
  commit(root, 'nested/missing', 'theirs\n', 'add nested/missing')
  mkdirSync(join(root, 'a', 'nested'), { recursive: true })
  commit(root, 'a/nested/y', 'theirs\n', 'add a/nested/y')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  // nested/ and a/nested/ are repositories of their own; nested/missing does not exist in mine.
  sh(root, 'init', '-q', 'nested')
  writeFileSync(join(root, 'nested', 'x'), 'mine\n')
  sh(root, 'init', '-q', 'a/nested')
  writeFileSync(join(root, 'a', 'nested', 'y'), 'mine\n')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['a/nested/y', 'nested/x'], repositories: [] })
})

test('the reset check lists a file or link inside a nested repository where the target needs a folder, without following links', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  for (const dir of ['file', 'link', 'emptylink', 'plain']) {
    mkdirSync(join(root, 'nested', dir), { recursive: true })
    commit(root, `nested/${dir}/x`, 'theirs\n', `add nested/${dir}/x`)
  }
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  // In my nested repository: a file, a link to an outside folder holding x, a link to one without x, a plain folder without x.
  const outside = mkdtempSync(join(tmpdir(), 'git-log-outside-'))
  dirs.push(outside)
  writeFileSync(join(outside, 'x'), 'outside\n')
  mkdirSync(join(outside, 'empty'))
  sh(root, 'init', '-q', 'nested')
  writeFileSync(join(root, 'nested', 'file'), 'my precious\n')
  symlinkSync(outside, join(root, 'nested', 'link'))
  symlinkSync(join(outside, 'empty'), join(root, 'nested', 'emptylink'))
  mkdirSync(join(root, 'nested', 'plain'))
  const listed = ['nested/emptylink', 'nested/file', 'nested/link']
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: listed, repositories: [] })
  // The reset replaces exactly the listed paths with folders and leaves the outside x alone.
  sh(root, 'reset', '-q', '--hard', target)
  for (const path of listed) assert.ok(lstatSync(join(root, path)).isDirectory(), path)
  assert.equal(readFileSync(join(outside, 'x'), 'utf8'), 'outside\n')
})

test('the reset check names the nested repositories a hard reset deletes whole', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  commit(root, 'nested', 'theirs\n', 'add nested')
  commit(root, 'a', 'theirs\n', 'add a')
  mkdirSync(join(root, 'outer'))
  commit(root, 'outer/inner', 'theirs\n', 'add outer/inner')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  // Files of the target where my repositories nested/ and outer/inner/ sit, and where a plain folder holds a file and a repository.
  sh(root, 'init', '-q', 'nested')
  sh(root, 'init', '-q', 'outer')
  sh(root, 'init', '-q', 'outer/inner')
  mkdirSync(join(root, 'a'))
  writeFileSync(join(root, 'a', 'f'), 'mine\n')
  sh(root, 'init', '-q', 'a/inner')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['a/f'], repositories: ['a/inner/', 'nested/', 'outer/inner/'] })
})

test('the reset check names every repository inside a folder the target replaces with a file', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  for (const file of ['sub', 'vendor', 'd']) commit(root, file, 'theirs\n', `add ${file}`)
  mkdirSync(join(root, 'nested'))
  commit(root, 'nested/sub', 'theirs\n', 'add nested/sub')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  // Tracked folders that hold a repository: vendor/ itself, d/e/ deeper, and the submodule sub/ with an edit.
  mkdirSync(join(root, 'vendor'))
  mkdirSync(join(root, 'd', 'e'), { recursive: true })
  commit(root, 'vendor/README', 'mine\n', 'add vendor')
  commit(root, 'd/e/b.txt', 'mine\n', 'add d')
  sh(root, 'init', '-q', 'vendor')
  sh(root, 'init', '-q', 'd/e')
  sh(root, 'clone', '-q', repo(), 'sub')
  sh(root, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub')
  sh(root, 'commit', '-q', '-m', 'add sub')
  writeFileSync(join(root, 'sub', 'c1.txt'), 'edited\n')
  // Untracked: my repository nested/ with a plain folder sub/ holding the repository deep/, and the tracked c1.txt turned into a folder.
  sh(root, 'init', '-q', 'nested')
  sh(root, 'init', '-q', 'nested/sub/deep')
  rmSync(join(root, 'c1.txt'))
  mkdirSync(join(root, 'c1.txt'))
  writeFileSync(join(root, 'c1.txt', 'f'), 'mine\n')
  sh(root, 'init', '-q', 'c1.txt/r')
  assert.deepEqual(await checkReset(git, root, target), {
    dirty: true,
    overwritten: ['c1.txt/f', 'nested/sub'],
    repositories: ['c1.txt/r/', 'd/e/', 'nested/sub/deep/', 'sub/', 'vendor/']
  })
  // The reset puts a file at each of those folders, deleting the repositories inside.
  sh(root, 'reset', '-q', '--hard', target)
  for (const path of ['c1.txt', 'd', 'nested/sub', 'sub', 'vendor']) assert.ok(lstatSync(join(root, path)).isFile(), path)
})

test('the reset check leaves out a folder where the target has a submodule, which a hard reset keeps', async () => {
  const root = repo()
  const git = createGit(root)
  const source = repo()
  const paths = ['nested', 'plain', 'file']
  sh(root, 'checkout', '-q', '-b', 'other')
  for (const path of paths) sh(root, 'clone', '-q', source, path)
  sh(root, '-c', 'advice.addEmbeddedRepo=false', 'add', ...paths)
  sh(root, 'commit', '-q', '-m', 'add submodules')
  const target = rev(root, 'HEAD')
  for (const path of paths) rmSync(join(root, path), { recursive: true, force: true })
  sh(root, 'checkout', '-q', 'main')
  // Where the target has a submodule: my repository, a plain folder, and a file.
  sh(root, 'init', '-q', 'nested')
  writeFileSync(join(root, 'nested', 'work.txt'), 'mine\n')
  mkdirSync(join(root, 'plain'))
  writeFileSync(join(root, 'plain', 'f'), 'mine\n')
  writeFileSync(join(root, 'file'), 'mine\n')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['file'], repositories: [] })
  sh(root, 'reset', '-q', '--hard', target)
  assert.equal(readFileSync(join(root, 'nested', 'work.txt'), 'utf8'), 'mine\n')
  assert.equal(readFileSync(join(root, 'plain', 'f'), 'utf8'), 'mine\n')
  assert.ok(lstatSync(join(root, 'file')).isDirectory())
})

test('the reset check names a folder too large to search for repositories instead of passing it', async () => {
  const root = repo()
  const git = createGit(root)
  sh(root, 'checkout', '-q', '-b', 'other')
  commit(root, 'big', 'theirs\n', 'add big')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  // Empty folders: git lists none, and there are more than the search reads.
  for (let i = 0; i <= 10_000; i++) mkdirSync(join(root, 'big', String(i)), { recursive: true })
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: [], repositories: [], unchecked: ['big'] })
})

test('with submodule.recurse the reset check names the submodules a hard reset also resets', async () => {
  const root = repo()
  const git = createGit(root)
  const source = repo()
  const add = (path: string) => sh(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, path)
  add('sub')
  sh(root, 'commit', '-q', '-m', 'add sub')
  sh(root, 'checkout', '-q', '-b', 'other')
  add('plain')
  sh(root, 'commit', '-q', '-m', 'add plain')
  const target = rev(root, 'HEAD')
  rmSync(join(root, 'plain'), { recursive: true, force: true })
  sh(root, 'checkout', '-q', 'main')
  // An edit and an untracked file in the submodule sub; a plain folder of mine where the target has the submodule plain.
  writeFileSync(join(root, 'sub', 'c1.txt'), 'edited\n')
  writeFileSync(join(root, 'sub', 'untracked.txt'), 'mine\n')
  mkdirSync(join(root, 'plain'))
  writeFileSync(join(root, 'plain', 'c1.txt'), 'mine\n')
  writeFileSync(join(root, 'plain', 'mine.txt'), 'mine\n')
  sh(root, 'config', 'submodule.recurse', 'true')
  assert.deepEqual(await checkReset(git, root, target), { dirty: true, overwritten: ['plain/c1.txt', 'plain/mine.txt'], repositories: [], submodules: ['sub/'] })
  // The reset follows the setting: it discards the edit in sub and checks plain out over my file.
  sh(root, 'reset', '-q', '--hard', target)
  assert.equal(readFileSync(join(root, 'sub', 'c1.txt'), 'utf8'), 'c1\n')
  assert.equal(readFileSync(join(root, 'plain', 'c1.txt'), 'utf8'), 'c1\n')
})

test('the reset check searches a folder standing where a file git assumes unchanged is tracked', async () => {
  const root = repo()
  const git = createGit(root)
  const target = rev(root, 'HEAD')
  // git status and git diff do not look at c1.txt any more, but a hard reset still puts the file back.
  sh(root, 'update-index', '--assume-unchanged', 'c1.txt')
  rmSync(join(root, 'c1.txt'))
  mkdirSync(join(root, 'c1.txt'))
  writeFileSync(join(root, 'c1.txt', 'f'), 'mine\n')
  sh(root, 'init', '-q', 'c1.txt/r')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['c1.txt/f'], repositories: ['c1.txt/r/'] })
  sh(root, 'reset', '-q', '--hard', target)
  assert.ok(lstatSync(join(root, 'c1.txt')).isFile())
})

test('the reset check splits a long list of paths over several git calls', async () => {
  const root = repo()
  const real = createGit(root)
  let calls = 0
  const git: Git = { ...real, out: (args, options) => ((calls += args[0] === 'ls-files' ? 1 : 0), real.out(args, options)) }
  sh(root, 'checkout', '-q', '-b', 'other')
  mkdirSync(join(root, 'long'))
  const names = Array.from({ length: 150 }, (_, i) => `long/${String(i).padStart(3, '0')}-${'x'.repeat(100)}.txt`)
  for (const name of names) writeFileSync(join(root, name), 'theirs\n')
  commit(root, 'c1.txt', 'c1\n', 'add long files')
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  const mine = [names[0], names[75], names[149]]
  mkdirSync(join(root, 'long'))
  for (const name of mine) writeFileSync(join(root, name), 'mine\n')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: mine, repositories: [] })
  // 150 pathspecs of about 120 characters each do not fit in one command line of at most 8 KB.
  assert.ok(calls > 2, `ls-files ran ${calls} times`)
})

test('the reset check works on a branch with no commits yet', async () => {
  const root = repo()
  const git = createGit(root)
  const target = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', '--orphan', 'fresh')
  // The files stay on disk but are no longer tracked: a hard reset to the target overwrites them.
  sh(root, 'rm', '-q', '-r', '--cached', '.')
  assert.deepEqual(await checkReset(git, root, target), { dirty: false, overwritten: ['c1.txt', 'c2.txt', 'c3.txt', 'c4.txt'], repositories: [] })
})

test('a clean tree stores no stash', async () => {
  const root = repo()
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  const result = await createBackup(git, { kind: 'branch', name: NAME, target: head, stash: true })
  assert.deepEqual(result, { ok: true, name: NAME })
  assert.equal(sh(root, 'stash', 'list'), '')
})

test('deleting an unmerged branch with a backup keeps its commits reachable', async () => {
  const root = repo()
  sh(root, 'checkout', '-q', '-b', 'topic')
  commit(root, 't.txt', 't\n', 'topic work')
  const tip = rev(root, 'HEAD')
  sh(root, 'checkout', '-q', 'main')
  const git = createGit(root)
  const name = 'backup/topic-20261110-1432'
  const result = await runGuarded(git, { backup: { kind: 'branch', name, target: tip } }, { branch: 'topic' }, () =>
    runBranchAction(git, { kind: 'delete', name: 'topic', force: true })
  )
  assert.equal(result.ok, true, result.message)
  assert.equal(result.backup, name)
  assert.equal(refs(root).includes('refs/heads/topic '), false)
  assert.equal(rev(root, `refs/heads/${name}`), tip)
})

test('restoring to a backup refuses when it would overwrite local changes', async () => {
  const root = repo()
  const git = createGit(root)
  const old = rev(root, 'HEAD')
  sh(root, 'branch', 'backup/main-old', old)
  commit(root, 'c4.txt', 'newer\n', 'c5')
  const head = rev(root, 'HEAD')
  writeFileSync(join(root, 'c4.txt'), 'local edit\n')
  const before = refs(root)
  const result = await runGuarded(git, { expectHead: head, backup: { kind: 'branch', name: NAME, target: head } }, 'HEAD', () =>
    runAction(git, { kind: 'reset', hash: old, mode: 'keep' })
  )
  assert.equal(result.ok, false)
  assert.equal(rev(root, 'HEAD'), head)
  assert.equal(readFileSync(join(root, 'c4.txt'), 'utf8'), 'local edit\n')
  // The backup was made before git refused; it is reported so the user knows it is there.
  assert.equal(result.backup, NAME)
  assert.equal(refs(root), `${before}\nrefs/heads/${NAME} ${head}`.split('\n').sort().join('\n'))
})

test('a moved HEAD refuses the action and makes no backup', async () => {
  const root = repo()
  const git = createGit(root)
  const seen = rev(root, 'HEAD~1')
  const before = refs(root)
  let ran = false
  const run = async () => {
    ran = true
    return { ok: true, message: 'ran' }
  }
  for (const guard of [
    { expectHead: seen },
    { expectHead: seen, backup: { kind: 'branch', name: NAME, target: seen } },
    { expectHead: 'HEAD' },
    { expectHead: 42 },
    // The backup must point at the HEAD the action rewrites.
    { backup: { kind: 'branch', name: NAME, target: seen } }
  ]) {
    const result = await runGuarded(git, guard, 'HEAD', run)
    assert.equal(result.ok, false, JSON.stringify(guard))
  }
  // A deleted branch's backup must point at that branch.
  const branch = await runGuarded(git, { backup: { kind: 'branch', name: NAME, target: seen } }, { branch: 'main' }, run)
  assert.equal(branch.ok, false)
  assert.equal(ran, false)
  assert.equal(refs(root), before)
  const head = rev(root, 'HEAD')
  assert.deepEqual(await runGuarded(git, { expectHead: head }, 'HEAD', run), { ok: true, message: 'ran', head })
})

test('delete backup removes only backup/ refs that still point where the user saw them', async () => {
  const root = repo()
  const git = createGit(root)
  const head = rev(root, 'HEAD')
  sh(root, 'branch', 'backup/main-1', head)
  sh(root, 'tag', 'backup/main-2', head)
  sh(root, 'branch', 'keep', head)
  const before = refs(root)
  for (const action of [
    { kind: 'deleteBackup', ref: 'branch', name: 'keep', hash: head },
    { kind: 'deleteBackup', ref: 'branch', name: 'backup/main-1', hash: rev(root, 'HEAD~1') },
    { kind: 'deleteBackup', ref: 'branch', name: 'backup/main-1', hash: 'HEAD' },
    { kind: 'deleteBackup', ref: 'tag', name: 'backup/main-1', hash: head },
    { kind: 'deleteBackup', ref: 'branch', name: 'backup/../keep', hash: head }
  ]) {
    const result = await deleteBackup(git, action)
    assert.equal(result.ok, false, JSON.stringify(action))
  }
  assert.equal(refs(root), before)
  assert.equal((await deleteBackup(git, { kind: 'deleteBackup', ref: 'branch', name: 'backup/main-1', hash: head })).ok, true)
  assert.equal((await deleteBackup(git, { kind: 'deleteBackup', ref: 'tag', name: 'backup/main-2', hash: head })).ok, true)
  assert.equal(refs(root).includes('backup/'), false)
})
