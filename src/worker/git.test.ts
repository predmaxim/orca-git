import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
import { checkRewrite, runAction } from './actions.ts'
import { createGit } from './git.ts'
import { gitCandidates, resolveGit } from './launch.ts'
import { readDetails, readLogPage, readRefs } from './log.ts'
import { readFileDiff } from './diff.ts'
import { createPatch } from './patch.ts'
import { buildTodo } from './rebase.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A repository with commits c1..cN (each adding fN.txt), returning hashes oldest first. */
function repo(count: number): { root: string; hashes: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'git-log-test-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  const hashes: string[] = []
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(root, `f${i}.txt`), `${i}\n`)
    sh(root, 'add', '.')
    sh(root, 'commit', '-q', '-m', `c${i}`, '-m', `body ${i}`)
    hashes.push(sh(root, 'rev-parse', 'HEAD'))
  }
  return { root, hashes }
}

const subjects = (root: string) => sh(root, 'log', '--format=%s').split('\n')
const files = (root: string) => sh(root, 'ls-tree', '--name-only', 'HEAD').split('\n')

test('squash folds the selected commits into the oldest with the new message', async () => {
  const { root, hashes } = repo(4)
  const git = createGit(root)
  const result = await runAction(git, { kind: 'squash', hashes: [hashes[3], hashes[1]], message: 'squashed\n\nall of it' })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(subjects(root), ['c3', 'squashed', 'c1'])
  assert.equal(sh(root, 'log', '-1', '--skip=1', '--format=%B'), 'squashed\n\nall of it')
  assert.deepEqual(files(root), ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'])
  assert.equal(result.previousHead, hashes[3])
})

test('drop removes commits and keeps the rest', async () => {
  const { root, hashes } = repo(4)
  const result = await runAction(createGit(root), { kind: 'drop', hashes: [hashes[1], hashes[2]] })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(subjects(root), ['c4', 'c1'])
  assert.deepEqual(files(root), ['f1.txt', 'f4.txt'])
})

test('fixup of one commit folds it into its parent and keeps the parent message', async () => {
  const { root, hashes } = repo(3)
  const result = await runAction(createGit(root), { kind: 'fixup', hashes: [hashes[2]] })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(subjects(root), ['c2', 'c1'])
  assert.deepEqual(files(root), ['f1.txt', 'f2.txt', 'f3.txt'])
})

test('reword changes one message, including the root commit', async () => {
  const { root, hashes } = repo(2)
  const result = await runAction(createGit(root), { kind: 'reword', hash: hashes[0], message: 'first!' })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(subjects(root), ['c2', 'first!'])
})

test('interactive rebase reorders, squashes with combined message and drops', async () => {
  const { root, hashes } = repo(4)
  const result = await runAction(createGit(root), {
    kind: 'rebase',
    plan: [
      { hash: hashes[1], action: 'pick' },
      { hash: hashes[3], action: 'squash' },
      { hash: hashes[2], action: 'drop' }
    ]
  })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(subjects(root), ['c2', 'c1'])
  assert.equal(sh(root, 'log', '-1', '--format=%B'), 'c2\n\nbody 2\n\nc4\n\nbody 4')
  assert.deepEqual(files(root), ['f1.txt', 'f2.txt', 'f4.txt'])
})

test('a conflicting rebase is aborted and the branch is left untouched', async () => {
  const { root, hashes } = repo(1)
  writeFileSync(join(root, 'f1.txt'), 'a\n')
  sh(root, 'commit', '-qam', 'edit a')
  writeFileSync(join(root, 'f1.txt'), 'b\n')
  sh(root, 'commit', '-qam', 'edit b')
  const head = sh(root, 'rev-parse', 'HEAD')
  const edits = sh(root, 'log', '--format=%H', '-n2').split('\n')
  const result = await runAction(createGit(root), { kind: 'drop', hashes: [edits[1]] })
  assert.equal(result.ok, false)
  assert.match(result.message, /aborted/)
  assert.equal(sh(root, 'rev-parse', 'HEAD'), head)
  assert.equal(sh(root, 'status', '--porcelain'), '')
  assert.ok(hashes[0])
})

test('uncommitted changes survive a rewrite (autostash)', async () => {
  const { root, hashes } = repo(3)
  writeFileSync(join(root, 'f1.txt'), 'dirty\n')
  const result = await runAction(createGit(root), { kind: 'drop', hashes: [hashes[1]] })
  assert.equal(result.ok, true, result.message)
  assert.equal(sh(root, 'status', '--porcelain'), 'M f1.txt')
})

test('checkRewrite refuses merges and reports pushed commits', async () => {
  const { root, hashes } = repo(3)
  const git = createGit(root)
  sh(root, 'update-ref', 'refs/remotes/origin/main', hashes[1])
  const pushed = await checkRewrite(git, 'drop', [hashes[2]])
  assert.deepEqual(pushed, { ok: true, pushed: [], commits: [{ hash: hashes[2], subject: 'c3', message: 'c3\n\nbody 3' }] })
  const old = await checkRewrite(git, 'drop', [hashes[0]])
  assert.equal(old.ok && old.pushed.join(), 'origin/main')
  sh(root, 'checkout', '-qb', 'side', hashes[0])
  writeFileSync(join(root, 'side.txt'), 'side\n')
  sh(root, 'add', '.')
  sh(root, 'commit', '-qm', 'side')
  sh(root, 'checkout', '-q', 'main')
  sh(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  const merged = await checkRewrite(git, 'drop', [hashes[1]])
  assert.equal(merged.ok, false)
  const undo = await checkRewrite(git, 'undo', [hashes[1]])
  assert.equal(undo.ok, false)
})

test('undo, reset, branch, tag, cherry-pick and revert', async () => {
  const { root, hashes } = repo(3)
  const git = createGit(root)
  assert.equal((await runAction(git, { kind: 'undo', hash: hashes[2] })).ok, true)
  assert.equal(sh(root, 'status', '--porcelain'), 'A  f3.txt')
  assert.equal((await runAction(git, { kind: 'reset', hash: hashes[1], mode: 'hard' })).ok, true)
  assert.equal((await runAction(git, { kind: 'tag', hash: hashes[0], name: 'v1' })).ok, true)
  assert.equal((await runAction(git, { kind: 'branch', hash: hashes[0], name: 'feature/x', checkout: true })).ok, true)
  assert.equal(sh(root, 'branch', '--show-current'), 'feature/x')
  assert.equal((await runAction(git, { kind: 'cherryPick', hashes: [hashes[1]] })).ok, true)
  assert.deepEqual(subjects(root), ['c2', 'c1'])
  assert.equal((await runAction(git, { kind: 'revert', hashes: [sh(root, 'rev-parse', 'HEAD')] })).ok, true)
  assert.match(subjects(root)[0], /^Revert "c2"/)
  assert.equal((await runAction(git, { kind: 'branch', hash: hashes[0], name: 'bad name', checkout: false })).ok, false)
  assert.equal((await runAction(git, { kind: 'checkout', target: 'main' })).ok, true)
  assert.equal(sh(root, 'branch', '--show-current'), 'main')
})

test('log pages, filters, refs and details', async () => {
  const { root, hashes } = repo(5)
  const git = createGit(root)
  sh(root, 'tag', 'v1', hashes[0])
  const first = await readLogPage(git, {}, 0, 3)
  assert.equal(first.commits.length, 3)
  assert.equal(first.hasMore, true)
  assert.deepEqual(first.commits[0].refs, ['refs/heads/main'])
  const rest = await readLogPage(git, {}, 3, 3)
  assert.equal(rest.hasMore, false)
  assert.deepEqual(rest.commits.at(-1)?.refs, ['refs/tags/v1'])
  assert.deepEqual((await readLogPage(git, { text: 'C3' }, 0, 50)).commits.map((c) => c.subject), ['c3'])
  assert.deepEqual((await readLogPage(git, { text: 'C3', matchCase: true }, 0, 50)).commits, [])
  assert.deepEqual((await readLogPage(git, { text: 'c[12]', regex: true }, 0, 50)).commits.map((c) => c.subject), ['c2', 'c1'])
  assert.deepEqual((await readLogPage(git, { text: hashes[3].slice(0, 8) }, 0, 50)).commits.map((c) => c.subject), ['c4'])
  assert.deepEqual((await readLogPage(git, { paths: ['f2.txt'] }, 0, 50)).commits.map((c) => c.subject), ['c2'])
  assert.equal((await readLogPage(git, { users: ['Nobody'] }, 0, 50)).commits.length, 0)
  assert.equal((await readLogPage(git, { users: ['Tester'], branches: ['v1'] }, 0, 50)).commits.length, 1)
  const refs = await readRefs(git)
  assert.equal(refs.head.branch, 'main')
  assert.deepEqual(refs.locals.map((r) => r.name), ['main'])
  assert.deepEqual(refs.tags.map((r) => r.name), ['v1'])
  assert.deepEqual(refs.users, ['Tester'])
  const details = await readDetails(git, hashes[1])
  assert.equal(details.message, 'c2\n\nbody 2')
  assert.deepEqual(details.files, [{ status: 'A', path: 'f2.txt' }])
  assert.deepEqual(details.branches, ['main'])
})

test('an empty repository has an empty log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-test-'))
  dirs.push(root)
  sh(root, 'init', '-q')
  assert.deepEqual(await readLogPage(createGit(root), {}, 0, 10), { commits: [], hasMore: false })
})

test('file diff covers modified, renamed, binary and root-commit files with line numbers', async () => {
  const { root, hashes } = repo(1)
  const git = createGit(root)
  const first = await readFileDiff(git, hashes[0], 'f1.txt')
  assert.deepEqual(first.hunks.map((x) => x.lines), [[{ kind: '+', text: '1', new: 1 }]])

  writeFileSync(join(root, 'f1.txt'), 'one\n2\n3\n4\n5\n6\n7\n8\nnine\n')
  sh(root, 'commit', '-qam', 'edit')
  const edit = await readFileDiff(git, sh(root, 'rev-parse', 'HEAD'), 'f1.txt')
  assert.equal(edit.binary, false)
  assert.deepEqual(edit.hunks[0].lines.slice(0, 3), [
    { kind: '-', text: '1', old: 1 },
    { kind: '+', text: 'one', new: 1 },
    { kind: '+', text: '2', new: 2 }
  ])
  assert.deepEqual(edit.hunks.at(-1)!.lines.at(-1), { kind: '+', text: 'nine', new: 9 })
  const whole = await readFileDiff(git, sh(root, 'rev-parse', 'HEAD'), 'f1.txt', undefined, true)
  assert.equal(whole.hunks.length, 1)
  assert.equal(whole.hunks[0].lines.length, 10)

  sh(root, 'mv', 'f1.txt', 'renamed.txt')
  sh(root, 'commit', '-qm', 'rename')
  const renamed = await readFileDiff(git, sh(root, 'rev-parse', 'HEAD'), 'renamed.txt', 'f1.txt')
  assert.deepEqual([renamed.oldPath, renamed.hunks.length, renamed.binary], ['f1.txt', 0, false])

  writeFileSync(join(root, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]))
  sh(root, 'add', '.')
  sh(root, 'commit', '-qm', 'binary')
  assert.equal((await readFileDiff(git, sh(root, 'rev-parse', 'HEAD'), 'img.bin')).binary, true)
  await assert.rejects(readFileDiff(git, 'HEAD', 'f1.txt'), /Invalid commit/)
})

test('create patch exports the selected commits oldest first, applies cleanly and refuses overwrites', async () => {
  const { root, hashes } = repo(4)
  const git = createGit(root)
  const preview = await createPatch(git, root, [hashes[3], hashes[1]])
  assert.ok(preview.ok && preview.text)
  assert.equal(preview.name, '2-commits.patch')
  const text = preview.text!
  assert.ok(text.indexOf('Subject: [PATCH] c2') < text.indexOf('Subject: [PATCH] c4'))
  assert.ok(!text.includes('Subject: [PATCH] c3'))

  const single = await createPatch(git, root, [hashes[0]])
  assert.equal(single.ok && single.name, 'c1.patch')

  const saved = await createPatch(git, root, [hashes[3]], 'out/last.patch')
  assert.ok(saved.ok && saved.path && existsSync(saved.path))
  sh(root, 'reset', '-q', '--hard', hashes[2])
  sh(root, 'apply', '--check', saved.path!)
  assert.match(readFileSync(saved.path!, 'utf8'), /^From [0-9a-f]{40} /)

  const again = await createPatch(git, root, [hashes[3]], 'out/last.patch')
  assert.deepEqual([again.ok, !again.ok && again.exists], [false, true])
  assert.equal((await createPatch(git, root, [hashes[3]], 'out/last.patch', true)).ok, true)
  await assert.rejects(createPatch(git, root, ['HEAD']), /Invalid commit/)
})
test('squash and reword todo lines amend with the configured git executable', () => {
  const hash = 'a'.repeat(40)
  const todo = buildTodo([{ hash, action: 'reword', message: 'New' }], new Map(), () => '/tmp/message.txt', '/opt/my git/bin/git')
  assert.ok(todo.includes(`exec '/opt/my git/bin/git' commit --amend`), todo)
})

test('a git in the repository never runs, even with . or an empty entry on PATH', { skip: process.platform === 'win32' }, async () => {
  const { root } = repo(1)
  const marker = join(root, '.git', 'decoy-ran')
  writeFileSync(join(root, 'git'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `.::${path}`
  try {
    const result = await createGit(root).run(['rev-parse', '--show-toplevel'])
    assert.equal(result.ok, true, result.stderr)
  } finally {
    process.env.PATH = path
  }
  assert.equal(existsSync(marker), false)
})

test('an inherited GIT_DIR or config from the environment never reaches git', async () => {
  const { root } = repo(1)
  const other = repo(2)
  const inherited = { GIT_DIR: join(other.root, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Intruder' }
  Object.assign(process.env, inherited)
  try {
    const git = createGit(root)
    assert.equal((await git.out(['log', '--format=%s'])).trim(), 'c1')
    assert.equal((await git.out(['config', 'user.name'])).trim(), 'Tester')
  } finally {
    for (const key of Object.keys(inherited)) delete process.env[key]
  }
})

test('a bare git name is looked up only in absolute PATH entries; a relative path is refused', { skip: process.platform === 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'git-path-'))
  dirs.push(base)
  const exe = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'git'), '#!/bin/sh\n', { mode: 0o755 })
    return join(dir, 'git')
  }
  const decoy = exe(join(base, 'repo'))
  mkdirSync(join(base, 'empty'))
  writeFileSync(join(base, 'empty', 'git'), 'not executable\n')
  const real = exe(join(base, 'bin'))
  const PATH = ['', '.', relative(process.cwd(), join(base, 'repo')), join(base, 'empty'), join(base, 'bin')].join(':')
  assert.equal(resolveGit('git', { PATH }, 'linux'), real)
  assert.throws(() => resolveGit('git', { PATH: `:.:${relative(process.cwd(), join(base, 'repo'))}` }, 'linux'), /PATH/)
  assert.equal(resolveGit(decoy, {}, 'linux'), decoy)
  assert.throws(() => resolveGit(join(base, 'missing'), { PATH }, 'linux'), /not a file that can be run/)
  assert.throws(() => resolveGit('./git', { PATH }, 'linux'), /relative path/)
  assert.throws(() => resolveGit('repo/git', { PATH }, 'linux'), /relative path/)
})

test('on Windows git is looked up with the .com and .exe of PATHEXT in each absolute PATH folder', () => {
  const env = { PATH: 'C:\\Git\\cmd;;.;tools;"D:\\Quoted Dir"', PATHEXT: '.BAT;.COM;.EXE;.CMD' }
  assert.deepEqual(gitCandidates('git', env, 'win32'), ['C:\\Git\\cmd\\git.COM', 'C:\\Git\\cmd\\git.EXE', 'D:\\Quoted Dir\\git.COM', 'D:\\Quoted Dir\\git.EXE'])
  assert.deepEqual(gitCandidates('git.exe', env, 'win32'), ['C:\\Git\\cmd\\git.exe', 'D:\\Quoted Dir\\git.exe'])
  assert.throws(() => resolveGit('.\\git.exe', env, 'win32'), /relative path/)
  assert.throws(() => resolveGit('C:git.exe', env, 'win32'), /relative path/)
})
