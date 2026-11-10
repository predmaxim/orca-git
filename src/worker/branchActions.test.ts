import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { runAction } from './actions.ts'
import { checkRebaseOnto, fetchAll, runBranchAction } from './branchActions.ts'
import { createGit } from './git.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'git-log-branches-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  return root
}

function commit(root: string, file: string, text: string, message: string): void {
  writeFileSync(join(root, file), text)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', message)
}

const hasRef = (root: string, ref: string) => {
  try {
    sh(root, 'rev-parse', '--verify', '-q', ref)
    return true
  } catch {
    return false
  }
}

/** main has c1; `topic` adds t.txt on top of it; HEAD is back on main with m.txt added. */
function diverged(): string {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'checkout', '-q', '-b', 'topic')
  commit(root, 't.txt', 't\n', 'topic work')
  sh(root, 'checkout', '-q', 'main')
  commit(root, 'm.txt', 'm\n', 'main work')
  return root
}

test('rename moves the branch', async () => {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'branch', 'old')
  const result = await runBranchAction(createGit(root), { kind: 'rename', name: 'old', newName: 'new' })
  assert.deepEqual([result.ok, result.message], [true, 'Renamed old to new.'])
  assert.ok(hasRef(root, 'refs/heads/new'))
  assert.ok(!hasRef(root, 'refs/heads/old'))
})

test('rename and new branch refuse names git expands to another branch', async () => {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  // @{-1} names the previous branch, deleted since; @{u} names an upstream that does not exist yet.
  sh(root, 'checkout', '-q', '-b', 'gone')
  sh(root, 'checkout', '-q', 'main')
  sh(root, 'branch', '-q', '-D', 'gone')
  sh(root, 'config', 'branch.main.remote', '.')
  sh(root, 'config', 'branch.main.merge', 'refs/heads/upstream')
  sh(root, 'branch', 'old')
  const git = createGit(root)
  const hash = sh(root, 'rev-parse', 'HEAD')
  const refs = () => sh(root, 'for-each-ref', '--format=%(refname)')
  const before = refs()
  for (const name of ['@{-1}', '@{u}', 'a@{1}']) {
    const refused = [false, `"${name}" is not a valid branch name.`]
    const renamed = await runBranchAction(git, { kind: 'rename', name: 'old', newName: name })
    assert.deepEqual([renamed.ok, renamed.message], refused, `rename to ${name}`)
    for (const checkout of [false, true]) {
      const created = await runAction(git, { kind: 'branch', hash, name, checkout })
      assert.deepEqual([created.ok, created.message], refused, `new branch ${name}`)
    }
  }
  assert.equal(refs(), before)
  assert.equal(sh(root, 'branch', '--show-current'), 'main')
})

test('delete removes a merged branch and refuses the current one', async () => {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'branch', 'done')
  const git = createGit(root)
  assert.equal((await runBranchAction(git, { kind: 'delete', name: 'done', force: false })).ok, true)
  assert.ok(!hasRef(root, 'refs/heads/done'))
  const current = await runBranchAction(git, { kind: 'delete', name: 'main', force: true })
  assert.deepEqual([current.ok, current.message], [false, 'Cannot delete the current branch.'])
  assert.ok(hasRef(root, 'refs/heads/main'))
})

test('an unmerged branch needs force, and force deletes it', async () => {
  const root = diverged()
  const git = createGit(root)
  const first = await runBranchAction(git, { kind: 'delete', name: 'topic', force: false })
  assert.equal(first.ok, false)
  assert.equal(first.needsForce, true)
  assert.ok(hasRef(root, 'refs/heads/topic'))
  // Only a literal true forces: anything else a frame sends stays the safe -d.
  const loose = await runBranchAction(git, { kind: 'delete', name: 'topic', force: 'true' as unknown as boolean })
  assert.equal(loose.needsForce, true)
  assert.ok(hasRef(root, 'refs/heads/topic'))
  const forced = await runBranchAction(git, { kind: 'delete', name: 'topic', force: true })
  assert.equal(forced.ok, true)
  assert.ok(!hasRef(root, 'refs/heads/topic'))
})

test('merge brings the branch in and reports the previous head', async () => {
  const root = diverged()
  const before = sh(root, 'rev-parse', 'HEAD')
  const result = await runBranchAction(createGit(root), { kind: 'merge', name: 'refs/heads/topic' })
  assert.equal(result.ok, true)
  assert.equal(result.previousHead, before)
  sh(root, 'merge-base', '--is-ancestor', 'topic', 'HEAD')
})

test('a conflicting merge is aborted and the tree is left clean', async () => {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'checkout', '-q', '-b', 'topic')
  commit(root, 'a.txt', 'topic\n', 'topic edit')
  sh(root, 'checkout', '-q', 'main')
  commit(root, 'a.txt', 'main\n', 'main edit')
  const result = await runBranchAction(createGit(root), { kind: 'merge', name: 'refs/heads/topic' })
  assert.equal(result.ok, false)
  assert.ok(result.message.startsWith('Merge failed and was aborted.'))
  assert.ok(!existsSync(join(root, '.git', 'MERGE_HEAD')))
  assert.equal(sh(root, 'status', '--porcelain'), '')
})

test('rebase onto replays the current branch on the target', async () => {
  const root = diverged()
  sh(root, 'checkout', '-q', 'topic')
  const result = await runBranchAction(createGit(root), { kind: 'rebaseOnto', name: 'refs/heads/main' })
  assert.equal(result.ok, true)
  assert.deepEqual(sh(root, 'log', '--format=%s').split('\n'), ['topic work', 'main work', 'c1'])
})

/** c1 has a.txt and b.txt; topic edits a.txt, main edits b.txt; HEAD is on main. */
function forked(): string {
  const root = newRepo()
  writeFileSync(join(root, 'b.txt'), '1\n')
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'checkout', '-q', '-b', 'topic')
  commit(root, 'a.txt', 'topic\n', 'topic edit')
  sh(root, 'checkout', '-q', 'main')
  commit(root, 'b.txt', 'main\n', 'main edit')
  return root
}

test('merge and rebase onto keep uncommitted changes the target does not touch', async () => {
  const merged = forked()
  writeFileSync(join(merged, 'b.txt'), 'local\n')
  const merge = await runBranchAction(createGit(merged), { kind: 'merge', name: 'refs/heads/topic' })
  assert.equal(merge.ok, true)
  assert.ok(merge.previousHead)
  assert.equal(readFileSync(join(merged, 'b.txt'), 'utf8'), 'local\n')
  assert.equal(sh(merged, 'stash', 'list'), '')

  const rebased = forked()
  sh(rebased, 'checkout', '-q', 'topic')
  writeFileSync(join(rebased, 'a.txt'), 'local\n')
  const rebase = await runBranchAction(createGit(rebased), { kind: 'rebaseOnto', name: 'refs/heads/main' })
  assert.equal(rebase.ok, true)
  assert.ok(rebase.previousHead)
  assert.equal(readFileSync(join(rebased, 'a.txt'), 'utf8'), 'local\n')
  assert.equal(sh(rebased, 'stash', 'list'), '')
})

test('merge and rebase onto warn, without undo, when the uncommitted changes cannot be re-applied', async () => {
  const merged = forked()
  writeFileSync(join(merged, 'a.txt'), 'local\n')
  const merge = await runBranchAction(createGit(merged), { kind: 'merge', name: 'refs/heads/topic' })
  assert.equal(merge.ok, true)
  assert.equal(merge.warning, true)
  assert.equal(merge.previousHead, undefined)
  assert.ok(merge.message.startsWith('Merged topic into the current branch.'), merge.message)
  assert.ok(merge.message.includes('git stash list'), merge.message)
  assert.match(sh(merged, 'stash', 'list'), /autostash/)

  const rebased = forked()
  sh(rebased, 'checkout', '-q', 'topic')
  writeFileSync(join(rebased, 'b.txt'), 'local\n')
  const rebase = await runBranchAction(createGit(rebased), { kind: 'rebaseOnto', name: 'refs/heads/main' })
  assert.equal(rebase.ok, true)
  assert.equal(rebase.warning, true)
  assert.equal(rebase.previousHead, undefined)
  assert.ok(rebase.message.startsWith('Rebased the current branch onto main.'), rebase.message)
  assert.match(sh(rebased, 'stash', 'list'), /autostash/)
})

/** c1 has a.txt and b.txt; topic and main both edit a.txt; HEAD is on main. */
function conflicting(): string {
  const root = newRepo()
  writeFileSync(join(root, 'b.txt'), '1\n')
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'checkout', '-q', '-b', 'topic')
  commit(root, 'a.txt', 'topic\n', 'topic edit')
  sh(root, 'checkout', '-q', 'main')
  commit(root, 'a.txt', 'main\n', 'main edit')
  return root
}

/** Everything a failed action must leave as it was. */
const snapshot = (root: string) => [sh(root, 'for-each-ref', '--format=%(refname) %(objectname)'), sh(root, 'symbolic-ref', 'HEAD'), sh(root, 'status', '--porcelain'), sh(root, 'stash', 'list')]

test('a conflicting merge or rebase onto is aborted and gives the uncommitted changes back', async () => {
  const merged = conflicting()
  writeFileSync(join(merged, 'b.txt'), 'local\n')
  const before = snapshot(merged)
  const merge = await runBranchAction(createGit(merged), { kind: 'merge', name: 'refs/heads/topic' })
  assert.equal(merge.ok, false)
  assert.ok(merge.message.startsWith('Merge failed and was aborted.'), merge.message)
  assert.deepEqual(snapshot(merged), before)
  assert.equal(readFileSync(join(merged, 'b.txt'), 'utf8'), 'local\n')

  const rebased = conflicting()
  sh(rebased, 'checkout', '-q', 'topic')
  writeFileSync(join(rebased, 'b.txt'), 'local\n')
  const beforeRebase = snapshot(rebased)
  const rebase = await runBranchAction(createGit(rebased), { kind: 'rebaseOnto', name: 'refs/heads/main' })
  assert.equal(rebase.ok, false)
  assert.ok(rebase.message.startsWith('Rebase failed and was aborted.'), rebase.message)
  assert.deepEqual(snapshot(rebased), beforeRebase)
  assert.equal(readFileSync(join(rebased, 'b.txt'), 'utf8'), 'local\n')
  assert.ok(!existsSync(join(rebased, '.git', 'rebase-merge')))
})

test('merge, rebase onto and their check refuse targets that are not one commit', async () => {
  const root = forked()
  writeFileSync(join(root, 'b.txt'), 'local\n')
  const git = createGit(root)
  const before = snapshot(root)
  for (const name of ['-x', '--abort', '--upload-pack=touch x', '', '   ', 'main..topic', 'topic~9', 'nope', 123 as unknown as string]) {
    for (const kind of ['merge', 'rebaseOnto'] as const) {
      const result = await runBranchAction(git, { kind, name })
      assert.equal(result.ok, false, `${kind} ${name}`)
      assert.match(result.message, /is not a local or remote branch/)
    }
    await assert.rejects(checkRebaseOnto(git, name), /is not a local or remote branch/)
  }
  assert.deepEqual(snapshot(root), before)
  assert.ok(!existsSync(join(root, 'x')))
})

test('the rebase onto check names the remote branches holding commits it would rewrite', async () => {
  const base = mkdtempSync(join(tmpdir(), 'git-log-pushed-'))
  dirs.push(base)
  sh(base, 'init', '-q', '--bare', 'origin.git')
  const root = forked()
  sh(root, 'remote', 'add', 'origin', join(base, 'origin.git'))
  sh(root, 'checkout', '-q', 'topic')
  const git = createGit(root)
  assert.deepEqual(await checkRebaseOnto(git, 'refs/heads/main'), { pushed: [] })
  sh(root, 'push', '-q', 'origin', 'main', 'topic')
  assert.deepEqual(await checkRebaseOnto(git, 'refs/heads/main'), { pushed: ['origin/topic'] })
  assert.deepEqual(await checkRebaseOnto(git, 'refs/heads/topic'), { pushed: [] })
  await assert.rejects(checkRebaseOnto(git, '--all'), /is not a local or remote branch/)
  // Only reads: the branch, the remote branches and the tree stay as they were.
  const before = snapshot(root)
  await checkRebaseOnto(git, 'refs/heads/main')
  assert.deepEqual(snapshot(root), before)
})

test('merge is refused while a rebase is in progress', async () => {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'checkout', '-q', '-b', 'topic')
  commit(root, 'a.txt', 'topic\n', 'topic edit')
  sh(root, 'checkout', '-q', 'main')
  commit(root, 'a.txt', 'main\n', 'main edit')
  sh(root, 'checkout', '-q', 'topic')
  assert.throws(() => sh(root, 'rebase', 'main'))
  const result = await runBranchAction(createGit(root), { kind: 'merge', name: 'refs/heads/main' })
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('in progress'))
})

test('fetch updates remote branches without touching the work tree', async () => {
  const base = mkdtempSync(join(tmpdir(), 'git-log-fetch-'))
  dirs.push(base)
  const bare = join(base, 'origin.git')
  sh(base, 'init', '-q', '--bare', '-b', 'main', bare)
  const clone = (name: string) => {
    sh(base, 'clone', '-q', bare, name)
    const dir = join(base, name)
    for (const [key, value] of [['user.name', 'Tester'], ['user.email', 'tester@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) sh(dir, 'config', key, value)
    return dir
  }
  const first = clone('first')
  commit(first, 'a.txt', '1\n', 'c1')
  sh(first, 'push', '-q', 'origin', 'main')
  const second = clone('second')
  commit(second, 'b.txt', '2\n', 'c2')
  sh(second, 'push', '-q', 'origin', 'main')
  const head = sh(first, 'rev-parse', 'HEAD')
  const result = await fetchAll(createGit(first))
  assert.deepEqual([result.ok, result.message], [true, 'Fetched all remotes.'])
  assert.equal(sh(first, 'rev-parse', 'origin/main'), sh(second, 'rev-parse', 'HEAD'))
  assert.equal(sh(first, 'rev-parse', 'HEAD'), head)
})

test('fetch reports an unreachable remote instead of hanging', async () => {
  const root = newRepo()
  commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'remote', 'add', 'origin', join(root, 'nonexistent', 'repo.git'))
  const result = await fetchAll(createGit(root))
  assert.equal(result.ok, false)
  assert.ok(result.message.startsWith('Fetch failed.'))
})

test('fetch without remotes says so', async () => {
  const root = newRepo()
  const result = await fetchAll(createGit(root))
  assert.deepEqual([result.ok, result.message], [false, 'No remotes configured.'])
})
