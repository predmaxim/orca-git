import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { runAction } from './actions.ts'
import { trimRisk } from './checkout.ts'
import { createGit } from './git.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const write = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')

/**
 * main: f.txt "a", same.txt "s", .gitignore (build/, *.log, node_modules/). topic: f.txt "b", and it tracks
 * secret.log (ignored on main), a file `build` (an ignored folder on main) and a file `notes`.
 */
function newRepo(extra: (root: string) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), 'git-log-checkout-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  write(root, 'f.txt', 'a\n')
  write(root, 'same.txt', 's\n')
  write(root, '.gitignore', 'build/\n*.log\nnode_modules/\n')
  extra(root)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'main')
  sh(root, 'switch', '-q', '-c', 'topic')
  write(root, 'f.txt', 'b\n')
  write(root, 'secret.log', 'tracked on topic\n')
  write(root, 'build', 'a file on topic\n')
  write(root, 'notes', 'a file on topic\n')
  sh(root, 'add', '-A')
  sh(root, 'add', '-f', 'secret.log')
  sh(root, 'commit', '-q', '-m', 'topic')
  sh(root, 'switch', '-q', 'main')
  return root
}

const branch = (root: string) => sh(root, 'symbolic-ref', '--short', 'HEAD')
const toTopic = { kind: 'checkout' as const, target: 'topic' }

test('nothing to lose: the checkout runs', async () => {
  const root = newRepo()
  const result = await runAction(createGit(root), toTopic)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.atRisk, undefined)
  assert.equal(branch(root), 'topic')
})

test('same commit: a new branch at HEAD keeps the changes without asking', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  const result = await runAction(createGit(root), { kind: 'branch', hash: sh(root, 'rev-parse', 'HEAD'), name: 'here', checkout: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.atRisk, undefined)
  assert.equal(branch(root), 'here')
  assert.equal(read(root, 'same.txt'), 'mine\n')
})

test('tracked change, same in both: asks, and carry takes it along', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  const git = createGit(root)
  const asked = await runAction(git, toTopic)
  assert.equal(asked.ok, false)
  assert.deepEqual(asked.atRisk, { changed: ['same.txt'], conflicts: [], untracked: [], ignored: [], carry: true, more: 0 })
  assert.equal(branch(root), 'main')
  const carried = await runAction(git, { ...toTopic, carry: true })
  assert.equal(carried.ok, true, carried.message)
  assert.equal(branch(root), 'topic')
  assert.equal(read(root, 'same.txt'), 'mine\n')
})

test('tracked conflict: git would refuse, so carry is off', async () => {
  const root = newRepo()
  write(root, 'f.txt', 'mine\n')
  const asked = await runAction(createGit(root), toTopic)
  assert.deepEqual(asked.atRisk?.conflicts, ['f.txt'])
  assert.equal(asked.atRisk?.carry, false)
})

test('an ignored file the target tracks would be overwritten: it is named and carry is off', async () => {
  const root = newRepo()
  write(root, 'secret.log', 'mine\n')
  const asked = await runAction(createGit(root), toTopic)
  assert.deepEqual(asked.atRisk?.ignored, ['secret.log'])
  assert.equal(asked.atRisk?.carry, false)
  assert.equal(read(root, 'secret.log'), 'mine\n')
})

test('an ignored folder where the target has a file would be deleted: its files are named', async () => {
  const root = newRepo()
  write(root, 'build/out.txt', 'mine\n')
  const asked = await runAction(createGit(root), toTopic)
  assert.deepEqual(asked.atRisk?.ignored, ['build/out.txt'])
  assert.equal(asked.atRisk?.carry, false)
})

test('an untracked folder where the target has a file: named, and carry is off', async () => {
  const root = newRepo()
  write(root, 'notes/a.txt', 'mine\n')
  const asked = await runAction(createGit(root), toTopic)
  assert.deepEqual(asked.atRisk?.untracked, ['notes/a.txt'])
  assert.equal(asked.atRisk?.carry, false)
})

test('an assume-unchanged edit is left to git, which refuses', async () => {
  const root = newRepo()
  sh(root, 'update-index', '--assume-unchanged', 'f.txt')
  write(root, 'f.txt', 'mine\n')
  const result = await runAction(createGit(root), toTopic)
  assert.equal(result.ok, false)
  assert.equal(result.atRisk, undefined)
  assert.match(result.message, /would be overwritten/)
  assert.equal(branch(root), 'main')
  assert.equal(read(root, 'f.txt'), 'mine\n')
})

test('stash: changes, untracked files and ignored files in the way go to one named stash; other ignored files stay', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  write(root, 'u.txt', 'untracked\n')
  write(root, 'secret.log', 'mine\n')
  write(root, 'node_modules/x', 'kept\n')
  const result = await runAction(createGit(root), { ...toTopic, stash: true })
  assert.equal(result.ok, true, result.message)
  assert.match(result.stash ?? '', /^[0-9a-f]{40}$/)
  assert.equal(branch(root), 'topic')
  assert.equal(read(root, 'same.txt'), 's\n')
  assert.equal(existsSync(join(root, 'u.txt')), false)
  assert.equal(read(root, 'secret.log'), 'tracked on topic\n')
  assert.equal(read(root, 'node_modules/x'), 'kept\n')
  const list = sh(root, 'stash', 'list').split('\n')
  assert.equal(list.length, 1)
  assert.match(list[0], /git-log: main → topic, \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.ok(result.message.includes('git-log: main → topic'), result.message)
  sh(root, 'switch', '-q', 'main')
  sh(root, 'stash', 'pop', '-q')
  assert.equal(read(root, 'same.txt'), 'mine\n')
  assert.equal(read(root, 'u.txt'), 'untracked\n')
  assert.equal(read(root, 'secret.log'), 'mine\n')
})

test('stash kept when the switch fails: HEAD stays, the message names the stash', async () => {
  const root = newRepo()
  sh(root, 'update-index', '--assume-unchanged', 'f.txt')
  write(root, 'f.txt', 'mine\n')
  write(root, 'same.txt', 'mine\n')
  const result = await runAction(createGit(root), { ...toTopic, stash: true })
  assert.equal(result.ok, false)
  assert.match(result.stash ?? '', /^[0-9a-f]{40}$/)
  assert.ok(result.message.includes('git-log: main → topic'), result.message)
  assert.equal(branch(root), 'main')
  assert.equal(read(root, 'same.txt'), 's\n')
  assert.equal(read(root, 'f.txt'), 'mine\n')
})

test('carry refused when something would be lost: nothing is touched', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  write(root, 'secret.log', 'mine\n')
  const result = await runAction(createGit(root), { ...toTopic, carry: true })
  assert.equal(result.ok, false)
  assert.equal(branch(root), 'main')
  assert.equal(read(root, 'same.txt'), 'mine\n')
  assert.equal(read(root, 'secret.log'), 'mine\n')
})

test('literal paths: names that look like pathspec magic or globs are stashed as they are', async () => {
  const names = ['a b.txt', 'ж.txt', '*.txt', ':(glob)x', '[a].txt']
  const root = newRepo((r) => names.forEach((name) => write(r, name, 'base\n')))
  names.forEach((name) => write(root, name, 'mine\n'))
  // An ignored file in the way makes the stash take a list of paths.
  write(root, 'secret.log', 'mine\n')
  write(root, 'keep.log', 'ignored, not in the way\n')
  const result = await runAction(createGit(root), { ...toTopic, stash: true })
  assert.equal(result.ok, true, result.message)
  for (const name of names) assert.equal(read(root, name), 'base\n', name)
  assert.equal(read(root, 'keep.log'), 'ignored, not in the way\n')
})

test('a staged rename goes to the stash whole: both of its paths come back', async () => {
  const root = newRepo()
  sh(root, 'mv', 'same.txt', 'moved.txt')
  const result = await runAction(createGit(root), { ...toTopic, stash: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(read(root, 'same.txt'), 's\n')
  assert.equal(existsSync(join(root, 'moved.txt')), false)
  sh(root, 'switch', '-q', 'main')
  sh(root, 'stash', 'pop', '-q')
  assert.equal(existsSync(join(root, 'same.txt')), false)
  assert.equal(read(root, 'moved.txt'), 's\n')
})

test('flags count only as true: stash: 1 stashes nothing and asks', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  const result = await runAction(createGit(root), { ...toTopic, stash: 1 as any })
  assert.equal(result.ok, false)
  assert.ok(result.atRisk)
  assert.equal(sh(root, 'stash', 'list'), '')
  assert.equal(read(root, 'same.txt'), 'mine\n')
})

test('a dirty submodule is not a change: git leaves it alone', async () => {
  const sub = mkdtempSync(join(tmpdir(), 'git-log-sub-'))
  dirs.push(sub)
  sh(sub, 'init', '-q', '-b', 'main')
  sh(sub, 'config', 'user.name', 'Tester')
  sh(sub, 'config', 'user.email', 'tester@example.com')
  write(sub, 's.txt', 'v1\n')
  sh(sub, 'add', '-A')
  sh(sub, 'commit', '-q', '-m', 's1')
  write(sub, 's.txt', 'v2\n')
  sh(sub, 'commit', '-q', '-am', 's2')
  const root = newRepo()
  sh(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'HEAD~1')
  sh(root, 'add', 'sm')
  sh(root, 'commit', '-q', '-m', 'sm at s1')
  sh(root, 'switch', '-q', '-c', 'later')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'main')
  sh(root, 'add', 'sm')
  sh(root, 'commit', '-q', '-m', 'sm at s2')
  sh(root, 'switch', '-q', 'main')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'HEAD~1')
  write(root, 'sm/s.txt', 'mine\n')
  const result = await runAction(createGit(root), { kind: 'checkout', target: 'later' })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.atRisk, undefined)
  assert.equal(read(root, 'sm/s.txt'), 'mine\n')
})

test('a hidden edit with only a staged deletion to stash: nothing is stashed, the edit and ignored files stay', async () => {
  const root = newRepo((r) => write(r, 'cfg.txt', 'base\n'))
  sh(root, 'update-index', '--assume-unchanged', 'cfg.txt')
  write(root, 'cfg.txt', 'mine\n')
  sh(root, 'rm', '-q', 'same.txt')
  write(root, 'node_modules/big', 'ignored\n')
  const result = await runAction(createGit(root), { ...toTopic, stash: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.stash, undefined)
  assert.equal(sh(root, 'stash', 'list'), '')
  assert.equal(read(root, 'cfg.txt'), 'mine\n')
  assert.equal(read(root, 'node_modules/big'), 'ignored\n')
})

test('a nested repository where the target writes: refused before anything changes', async () => {
  for (const ignored of [true, false]) {
    const root = newRepo()
    // The target writes vendor/lib/x.txt; vendor/lib is a clone of its own, with an uncommitted file there.
    sh(root, 'switch', '-q', 'topic')
    write(root, 'vendor/lib/x.txt', 'T\n')
    sh(root, 'add', '-f', 'vendor/lib/x.txt')
    sh(root, 'commit', '-q', '-m', 'vendor')
    sh(root, 'switch', '-q', 'main')
    if (ignored) write(root, '.git/info/exclude', 'vendor/\n')
    write(root, 'vendor/lib/x.txt', 'NESTED UNCOMMITTED\n')
    sh(join(root, 'vendor', 'lib'), 'init', '-q')
    write(root, 'same.txt', 'mine\n')
    for (const flags of [{}, { stash: true }, { carry: true }]) {
      const result = await runAction(createGit(root), { ...toTopic, ...flags })
      assert.equal(result.ok, false, `${ignored} ${JSON.stringify(flags)}`)
      assert.equal(result.atRisk, undefined)
      assert.match(result.message, /vendor\/lib/)
      assert.equal(branch(root), 'main')
      assert.equal(read(root, 'vendor/lib/x.txt'), 'NESTED UNCOMMITTED\n')
      assert.equal(read(root, 'same.txt'), 'mine\n')
      assert.equal(sh(root, 'stash', 'list'), '')
    }
  }
})

test('stash is refused before it is made when git would refuse the move anyway', async () => {
  const root = newRepo()
  const elsewhere = mkdtempSync(join(tmpdir(), 'git-log-wt-'))
  dirs.push(elsewhere)
  rmSync(elsewhere, { recursive: true })
  sh(root, 'worktree', 'add', '-q', elsewhere, 'topic')
  write(root, 'same.txt', 'mine\n')
  const busy = await runAction(createGit(root), { ...toTopic, stash: true })
  assert.equal(busy.ok, false)
  assert.ok(busy.message.includes(elsewhere), busy.message)
  const taken = await runAction(createGit(root), { kind: 'branch', hash: sh(root, 'rev-parse', 'topic'), name: 'topic', checkout: true, stash: true })
  assert.equal(taken.ok, false)
  assert.equal(sh(root, 'stash', 'list'), '')
  assert.equal(read(root, 'same.txt'), 'mine\n')
  assert.equal(branch(root), 'main')
})

test('a rename made in the files (intent to add) lists both paths, no stray ones', async () => {
  const root = newRepo()
  sh(root, 'mv', 'same.txt', 'renamed.txt')
  sh(root, 'reset', '-q', '--', 'same.txt', 'renamed.txt')
  sh(root, 'add', '-N', 'renamed.txt')
  const asked = await runAction(createGit(root), toTopic)
  assert.deepEqual([...(asked.atRisk?.changed ?? [])].sort(), ['renamed.txt', 'same.txt'])
})

test('a submodule at another commit is not a change: no question, and the checkout runs', async () => {
  const sub = mkdtempSync(join(tmpdir(), 'git-log-sub-'))
  dirs.push(sub)
  sh(sub, 'init', '-q', '-b', 'main')
  sh(sub, 'config', 'user.name', 'Tester')
  sh(sub, 'config', 'user.email', 'tester@example.com')
  write(sub, 's.txt', 'v1\n')
  sh(sub, 'add', '-A')
  sh(sub, 'commit', '-q', '-m', 's1')
  write(sub, 's.txt', 'v2\n')
  sh(sub, 'commit', '-q', '-am', 's2')
  const root = newRepo()
  sh(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm')
  sh(root, 'commit', '-q', '-m', 'sm')
  sh(root, 'switch', '-q', '-c', 'later')
  write(root, 'later.txt', 'later\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'later')
  sh(root, 'switch', '-q', 'main')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'HEAD~1')
  const result = await runAction(createGit(root), { kind: 'checkout', target: 'later' })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.atRisk, undefined)
  assert.equal(read(root, 'sm/s.txt'), 'v1\n')
})

/** main with submodule `sm` at s1; branch `later` moves it to s2. */
function withSubmodule(): string {
  const sub = mkdtempSync(join(tmpdir(), 'git-log-sub-'))
  dirs.push(sub)
  sh(sub, 'init', '-q', '-b', 'main')
  sh(sub, 'config', 'user.name', 'Tester')
  sh(sub, 'config', 'user.email', 'tester@example.com')
  write(sub, 's.txt', 'v1\n')
  sh(sub, 'add', '-A')
  sh(sub, 'commit', '-q', '-m', 's1')
  write(sub, 's.txt', 'v2\n')
  sh(sub, 'commit', '-q', '-am', 's2')
  const root = newRepo()
  sh(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'HEAD~1')
  sh(root, 'add', 'sm')
  sh(root, 'commit', '-q', '-m', 'sm at s1')
  sh(root, 'switch', '-q', '-c', 'later')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'main')
  sh(root, 'add', 'sm')
  sh(root, 'commit', '-q', '-m', 'sm at s2')
  sh(root, 'switch', '-q', 'main')
  sh(join(root, 'sm'), 'switch', '-q', '--detach', 'HEAD~1')
  return root
}

test('a file where a submodule folder was is a change: asked, and kept', async () => {
  const root = withSubmodule()
  rmSync(join(root, 'sm'), { recursive: true, force: true })
  write(root, 'sm', 'precious\n')
  const result = await runAction(createGit(root), { kind: 'checkout', target: 'later' })
  assert.equal(result.ok, false)
  assert.ok(result.atRisk?.changed.includes('sm'), JSON.stringify(result.atRisk))
  assert.equal(result.atRisk?.carry, false)
  assert.equal(branch(root), 'main')
  assert.equal(read(root, 'sm'), 'precious\n')
})

test('with submodule.recurse, a submodule at a commit of its own is a change: asked, and the commit stays', async () => {
  const root = withSubmodule()
  sh(root, 'config', 'submodule.recurse', 'true')
  const sm = join(root, 'sm')
  sh(sm, 'config', 'user.name', 'Tester')
  sh(sm, 'config', 'user.email', 'tester@example.com')
  write(sm, 'mine.txt', 'mine\n')
  sh(sm, 'add', '-A')
  sh(sm, 'commit', '-q', '-m', 'mine')
  const mine = sh(sm, 'rev-parse', 'HEAD')
  const result = await runAction(createGit(root), { kind: 'checkout', target: 'later' })
  assert.equal(result.ok, false)
  assert.ok(result.atRisk?.changed.includes('sm'), JSON.stringify(result.atRisk))
  assert.equal(branch(root), 'main')
  assert.equal(sh(sm, 'rev-parse', 'HEAD'), mine)
})

test('a stash someone else pushed while ours failed is not taken for ours', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  const real = createGit(root)
  // Another worktree's stash lands while our push fails before it records anything.
  const git = { ...real, run: async (args: string[], options?: any) => {
    if (args[0] !== 'stash' || args[1] !== 'push') return real.run(args, options)
    const theirs = (await real.out(['stash', 'create'])).trim()
    await real.out(['stash', 'store', '-m', 'On topic: someone else', theirs])
    return { ok: false, code: 1, stdout: '', stderr: 'Cannot save the current worktree state' }
  } }
  const result = await runAction(git, { ...toTopic, stash: true })
  assert.equal(result.ok, false)
  assert.equal(result.stash, undefined)
  assert.ok(!result.message.includes('git-log: main → topic'), result.message)
  assert.equal(read(root, 'same.txt'), 'mine\n')
  assert.equal(branch(root), 'main')
})

test('our stash is found under one someone else pushed right after it', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  write(root, 'other.txt', 'theirs\n')
  sh(root, 'add', 'other.txt')
  const real = createGit(root)
  let theirs = ''
  const git = { ...real, run: async (args: string[], options?: any) => {
    if (args[0] !== 'stash' || args[1] !== 'push') return real.run(args, options)
    const ours = await real.run(args, options)
    write(root, 'later.txt', 'theirs\n')
    sh(root, 'add', 'later.txt')
    theirs = (await real.out(['stash', 'create'])).trim()
    await real.out(['stash', 'store', '-m', 'On topic: someone else', theirs])
    sh(root, 'rm', '-q', '--cached', 'later.txt')
    rmSync(join(root, 'later.txt'))
    return ours
  } }
  const result = await runAction(git, { ...toTopic, stash: true })
  assert.equal(result.ok, true, result.message)
  assert.notEqual(result.stash, theirs)
  assert.match(sh(root, 'show', '-s', '--format=%s', result.stash!), /: git-log: main → topic, /)
})

test('a stash git made but then reported as failed is named, and HEAD stays', async () => {
  const root = newRepo()
  write(root, 'same.txt', 'mine\n')
  const real = createGit(root)
  // git records the stash, then fails to clean the files: the push exits non-zero after the stash exists.
  const git = { ...real, run: async (args: string[], options?: any) => {
    const result = await real.run(args, options)
    return args[0] === 'stash' && args[1] === 'push' ? { ...result, ok: false, code: 1, stderr: 'error: cleanup failed' } : result
  } }
  const result = await runAction(git, { ...toTopic, stash: true })
  assert.equal(result.ok, false)
  assert.match(result.stash ?? '', /^[0-9a-f]{40}$/)
  assert.ok(result.message.includes('git-log: main → topic'), result.message)
  assert.ok(result.message.includes('cleanup failed'), result.message)
  assert.equal(branch(root), 'main')
})

test('trimRisk counts each hidden path once', () => {
  const many = Array.from({ length: 60 }, (_, i) => `f${i}`)
  const trimmed = trimRisk({ changed: many, conflicts: many, untracked: [], ignored: [], carry: false, more: 0 })
  assert.equal(trimmed.more, 10)
})

test('trimRisk keeps 50 paths of each list and counts the rest', () => {
  const many = Array.from({ length: 60 }, (_, i) => `f${i}`)
  const trimmed = trimRisk({ changed: many, conflicts: [], untracked: many.slice(0, 5), ignored: [], carry: true, more: 0 })
  assert.equal(trimmed.changed.length, 50)
  assert.equal(trimmed.untracked.length, 5)
  assert.equal(trimmed.more, 10)
})
