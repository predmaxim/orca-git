import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ActionResult } from '../shared/protocol.ts'
import { runAction } from './actions.ts'
import { checkBackup, createBackup, deleteBackup, runGuarded } from './backup.ts'
import { runBranchAction } from './branchActions.ts'
import { createGit } from './git.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** main with c1..c4, one file each. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'git-log-backup-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
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
  const root = repo()
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
