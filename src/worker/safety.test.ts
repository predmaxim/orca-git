import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test } from 'node:test'
import type { ActionResult, PlanItem } from '../shared/protocol.ts'
import { checkRewrite, runAction } from './actions.ts'
import { createBackup, deleteBackup, runGuarded } from './backup.ts'
import { checkRebaseOnto, fetchAll, runBranchAction } from './branchActions.ts'
import { createGit, type Git } from './git.ts'
import { createPatch } from './patch.ts'
import { describeRepo } from './repo.ts'

// Every git operation of the plugin against the harmful cases in docs/git-safety.md: hostile input, failure,
// local changes, pushed commits and an operation a terminal left in progress.

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Runs git the way a user in a terminal would, where stopping on a conflict is expected. */
function terminal(cwd: string, args: string[], env: Record<string, string> = {}): void {
  try {
    execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' })
  } catch {
    // Stopped for the user, as intended.
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function repo(): string {
  const root = tempDir('git-log-safety-')
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  sh(root, 'config', 'core.autocrlf', 'false')
  return root
}

function commit(root: string, file: string, text: string, message: string): string {
  writeFileSync(join(root, file), text)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', message)
  return sh(root, 'rev-parse', 'HEAD')
}

interface World {
  root: string
  c1: string
  c2: string
  c3: string
  t1: string
  t2: string
}

/** main: c1 (a.txt, b.txt), c2 (adds c.txt), c3 (edits a.txt); topic from c1: t1 (edits a.txt), t2 (adds t.txt). HEAD on main. */
function world(): World {
  const root = repo()
  writeFileSync(join(root, 'b.txt'), '1\n')
  const c1 = commit(root, 'a.txt', '1\n', 'c1')
  sh(root, 'checkout', '-q', '-b', 'topic')
  const t1 = commit(root, 'a.txt', 'topic\n', 't1')
  const t2 = commit(root, 't.txt', 't\n', 't2')
  sh(root, 'checkout', '-q', 'main')
  const c2 = commit(root, 'c.txt', '2\n', 'c2')
  const c3 = commit(root, 'a.txt', 'main\n', 'c3')
  return { root, c1, c2, c3, t1, t2 }
}

const MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_AUTOSTASH']

/** Everything an operation that refuses or fails must leave as it was: refs, HEAD, index, files, stash and git's own state. */
function snapshot(root: string) {
  const files: Record<string, string> = {}
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    if (name === '.git' || name.startsWith(`.git${sep}`)) continue
    const path = join(root, name)
    if (lstatSync(path).isFile()) files[name] = readFileSync(path, 'utf8')
  }
  return {
    refs: sh(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: readFileSync(join(root, '.git', 'HEAD'), 'utf8'),
    index: sh(root, 'ls-files', '-s'),
    files,
    stash: sh(root, 'stash', 'list'),
    state: MARKERS.filter((name) => existsSync(join(root, '.git', name)))
  }
}

const MUTATING = new Set(['checkout', 'switch', 'branch', 'tag', 'reset', 'cherry-pick', 'revert', 'rebase', 'merge', 'fetch', 'stash', 'commit', 'update-ref'])

/** A git runner that remembers which git commands it started. */
function recorder(root: string): { git: Git; mutations: () => string[] } {
  const real = createGit(root)
  const verbs: string[] = []
  const note = (args: string[]) => {
    let i = 0
    while (args[i] === '-c') i += 2
    verbs.push(args[i])
  }
  const git: Git = {
    gitPath: real.gitPath,
    run: (args, options) => (note(args), real.run(args, options)),
    out: (args, options) => (note(args), real.out(args, options))
  }
  return { git, mutations: () => verbs.filter((verb) => MUTATING.has(verb)) }
}

type Result = { ok: boolean; message: string }

/** `run` must refuse before any git command that changes something starts, and leave the repository as it was. */
async function refusedBeforeGit(w: World, label: string, run: (git: Git) => Promise<Result>): Promise<void> {
  const before = snapshot(w.root)
  const { git, mutations } = recorder(w.root)
  const result = await run(git).catch((error: Error): Result => ({ ok: false, message: error.message }))
  assert.equal(result.ok, false, `${label}: ${result.message}`)
  assert.deepEqual(mutations(), [], label)
  assert.deepEqual(snapshot(w.root), before, label)
}

const NAMES: unknown[] = ['', '   ', '-x', '--force', 'a b', 'a..b', '@{-1}', 'a@{1}', 'x.lock', 'a~1', 'a^', 'a:b', '.x', 'x/', 'a\\b', 'a\0b', 42, null]
const hashes = (w: World): unknown[] => ['', 'HEAD', 'main', w.c1.slice(0, 12), `${w.c1}\n`, ` ${w.c1}`, w.c1.toUpperCase(), 'g'.repeat(40), `-${w.c1.slice(1)}`, 42, null]
const as = <T>(value: unknown) => value as T

// ---------- 1. Normal input ----------

test('checkout of a branch, a hash and a remote branch, reset in every mode, and Undo of an action', async () => {
  const w = world()
  const git = createGit(w.root)
  sh(w.root, 'remote', 'add', 'origin', join(w.root, 'nowhere.git'))
  sh(w.root, 'update-ref', 'refs/remotes/origin/feature', w.t2)
  assert.equal((await runAction(git, { kind: 'checkout', target: 'topic' })).ok, true)
  assert.equal(sh(w.root, 'branch', '--show-current'), 'topic')
  assert.equal((await runAction(git, { kind: 'checkout', target: w.c1 })).ok, true)
  assert.equal(sh(w.root, 'rev-parse', 'HEAD'), w.c1)
  assert.equal(sh(w.root, 'branch', '--show-current'), '')
  // A remote branch is checked out as a new local branch that tracks it.
  assert.equal((await runAction(git, { kind: 'checkout', target: 'feature', track: 'refs/remotes/origin/feature' })).ok, true)
  assert.equal(sh(w.root, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature')
  assert.equal((await runAction(git, { kind: 'checkout', target: 'main' })).ok, true)

  writeFileSync(join(w.root, 'b.txt'), 'local\n')
  for (const mode of ['soft', 'mixed', 'keep'] as const) {
    const result = await runAction(git, { kind: 'reset', hash: w.c2, mode })
    assert.equal(result.ok, true, result.message)
    assert.equal(sh(w.root, 'rev-parse', 'HEAD'), w.c2)
    assert.equal(readFileSync(join(w.root, 'b.txt'), 'utf8'), 'local\n', mode)
    sh(w.root, 'reset', '-q', '--soft', w.c3)
  }

  // Undo is a reset --keep to the HEAD before the action, bound to the HEAD the action left.
  const dropped = await runGuarded(git, { expectHead: w.c3 }, 'HEAD', () => runAction(git, { kind: 'drop', hashes: [w.c2] }))
  assert.equal(dropped.ok, true, dropped.message)
  const undo = await runGuarded(git, { expectHead: dropped.head }, 'HEAD', () => runAction(git, { kind: 'reset', hash: dropped.previousHead!, mode: 'keep' }))
  assert.equal(undo.ok, true, undo.message)
  assert.equal(sh(w.root, 'rev-parse', 'HEAD'), w.c3)
  assert.equal(readFileSync(join(w.root, 'b.txt'), 'utf8'), 'local\n')
})

// ---------- 2. Hostile input is refused before git changes anything ----------

test('checkout refuses anything but a branch or a full commit hash', async () => {
  const w = world()
  // @{-1} names topic, main@{1} the commit main was at before c3: git would check either out.
  sh(w.root, 'checkout', '-q', 'topic')
  sh(w.root, 'checkout', '-q', 'main')
  for (const target of ['', '  ', '-b', '--orphan=x', '-', 'a b', 'main..topic', 'main@{1}', '@{-1}', 'HEAD~1', 'topic^', 'main:a.txt', 'a\0b', 42, null]) {
    await refusedBeforeGit(w, `checkout ${JSON.stringify(target)}`, (git) => runAction(git, { kind: 'checkout', target: as(target) }))
  }
  // Names that pass as branch names but are a tag, the stash, ORIG_HEAD, a remote branch, a ref path or an abbreviated hash: git switch refuses them.
  sh(w.root, 'tag', 'v1', w.c1)
  sh(w.root, 'update-ref', 'refs/remotes/origin/main', w.c1)
  sh(w.root, 'update-ref', 'ORIG_HEAD', w.c1)
  writeFileSync(join(w.root, 'a.txt'), 'stashed\n')
  sh(w.root, 'stash', '-q')
  const before = snapshot(w.root)
  for (const target of ['v1', 'tags/v1', 'stash', 'ORIG_HEAD', 'origin/main', 'heads/topic', w.c1.slice(0, 12), 'HEAD']) {
    const result = await runAction(createGit(w.root), { kind: 'checkout', target })
    assert.equal(result.ok, false, `checkout ${target}: ${result.message}`)
    assert.deepEqual(snapshot(w.root), before, `checkout ${target}`)
  }
})

test('new branch and tag names under refs/ are refused before git runs', async () => {
  const w = world()
  sh(w.root, 'branch', 'old')
  // A branch named refs/heads/main is refs/heads/refs/heads/main, yet git reads that name as main: merge or rebase onto it would take main.
  for (const name of ['refs/heads/main', 'refs/heads/x', 'refs/tags/x', 'refs/x']) {
    for (const checkout of [false, true]) await refusedBeforeGit(w, `branch ${name}`, (git) => runAction(git, { kind: 'branch', hash: w.c1, name, checkout }))
    await refusedBeforeGit(w, `tag ${name}`, (git) => runAction(git, { kind: 'tag', hash: w.c1, name }))
    await refusedBeforeGit(w, `rename to ${name}`, (git) => runBranchAction(git, { kind: 'rename', name: 'old', newName: name }))
    await refusedBeforeGit(w, `checkout ${name}`, (git) => runAction(git, { kind: 'checkout', target: name }))
  }
})

test('engine actions refuse hostile names, hashes, modes and plans before git runs', async () => {
  const w = world()
  const bad = hashes(w)
  for (const name of NAMES) {
    for (const checkout of [false, true]) await refusedBeforeGit(w, `branch ${JSON.stringify(name)}`, (git) => runAction(git, { kind: 'branch', hash: w.c1, name: as(name), checkout }))
    await refusedBeforeGit(w, `tag ${JSON.stringify(name)}`, (git) => runAction(git, { kind: 'tag', hash: w.c1, name: as(name) }))
  }
  for (const hash of bad) {
    const label = JSON.stringify(hash)
    await refusedBeforeGit(w, `branch at ${label}`, (git) => runAction(git, { kind: 'branch', hash: as(hash), name: 'fresh', checkout: true }))
    await refusedBeforeGit(w, `tag at ${label}`, (git) => runAction(git, { kind: 'tag', hash: as(hash), name: 'v1' }))
    await refusedBeforeGit(w, `reset to ${label}`, (git) => runAction(git, { kind: 'reset', hash: as(hash), mode: 'hard' }))
    await refusedBeforeGit(w, `undo ${label}`, (git) => runAction(git, { kind: 'undo', hash: as(hash) }))
    await refusedBeforeGit(w, `reword ${label}`, (git) => runAction(git, { kind: 'reword', hash: as(hash), message: 'x' }))
    for (const kind of ['cherryPick', 'revert', 'squash', 'fixup', 'drop'] as const) {
      await refusedBeforeGit(w, `${kind} ${label}`, (git) => runAction(git, as({ kind, hashes: [hash], message: 'x' })))
      await refusedBeforeGit(w, `${kind} [c3, ${label}]`, (git) => runAction(git, as({ kind, hashes: [w.c3, hash], message: 'x' })))
    }
    await refusedBeforeGit(w, `rebase plan ${label}`, (git) => runAction(git, { kind: 'rebase', plan: [{ hash: as(hash), action: 'pick' }] }))
  }
  for (const kind of ['cherryPick', 'revert', 'squash', 'fixup', 'drop'] as const) {
    for (const list of [[], 'abc', null]) await refusedBeforeGit(w, `${kind} ${JSON.stringify(list)}`, (git) => runAction(git, as({ kind, hashes: list, message: 'x' })))
  }
  for (const mode of ['merge', 'hard --', '', 'HARD', '--hard', 42, null]) {
    await refusedBeforeGit(w, `reset --${mode}`, (git) => runAction(git, { kind: 'reset', hash: w.c1, mode: as(mode) }))
  }
  // Undo only takes back HEAD itself.
  await refusedBeforeGit(w, 'undo of an older commit', (git) => runAction(git, { kind: 'undo', hash: w.c2 }))
  for (const message of ['', '   ', 42, null]) {
    await refusedBeforeGit(w, `reword to ${JSON.stringify(message)}`, (git) => runAction(git, { kind: 'reword', hash: w.c3, message: as(message) }))
    await refusedBeforeGit(w, `squash to ${JSON.stringify(message)}`, (git) => runAction(git, { kind: 'squash', hashes: [w.c3, w.c2], message: as(message) }))
  }
  const plans: unknown[] = [
    [],
    'abc',
    null,
    // Only pick, reword, squash, fixup and drop: no exec, edit or break from a frame.
    [{ hash: w.c2, action: 'exec' }, { hash: w.c3, action: 'pick' }],
    [{ hash: w.c2, action: 'edit' }, { hash: w.c3, action: 'pick' }],
    [{ hash: w.c2, action: 'pick' }, { hash: w.c2, action: 'pick' }],
    [{ hash: w.c2, action: 'pick' }],
    [{ hash: w.t1, action: 'pick' }],
    [{ hash: w.c3, action: 'squash' }, { hash: w.c2, action: 'pick' }],
    [{ hash: w.c2, action: 'reword', message: '   ' }, { hash: w.c3, action: 'pick' }]
  ]
  for (const plan of plans) await refusedBeforeGit(w, `rebase plan ${JSON.stringify(plan)}`, (git) => runAction(git, { kind: 'rebase', plan: as<PlanItem[]>(plan) }))
})

test('merge and rebase onto take the full name of a branch, never a ref its short name could mean', async () => {
  // Each branch the menu shows shares its short name with another ref: heads/evil means evil, tags/x tag x, and tag v1 wins over branch v1.
  const cases: [string, (root: string, at: string) => void][] = [
    ['heads/evil', (root, at) => sh(root, 'branch', 'evil', at)],
    ['tags/x', (root, at) => sh(root, 'tag', 'x', at)],
    ['v1', (root, at) => sh(root, 'tag', 'v1', at)],
    ['refs/heads/main', () => {}]
  ]
  for (const [branch, other] of cases) {
    for (const kind of ['merge', 'rebaseOnto'] as const) {
      const root = repo()
      const c1 = commit(root, 'a.txt', '1\n', 'c1')
      sh(root, 'checkout', '-q', '-b', 'side-x')
      const x = commit(root, 'x.txt', 'x\n', 'x')
      sh(root, 'checkout', '-q', '-b', 'side-y', c1)
      const y = commit(root, 'y.txt', 'y\n', 'y')
      sh(root, 'checkout', '-q', 'main')
      sh(root, 'branch', branch, x)
      other(root, y)
      const git = createGit(root)
      const before = snapshot(root)
      const label = `${kind} ${branch}`
      if (branch !== 'refs/heads/main') {
        assert.equal((await runBranchAction(git, { kind, name: branch })).ok, false, label)
        await assert.rejects(checkRebaseOnto(git, branch), label)
      }
      for (const name of ['refs/heads/nope', 'refs/heads/side-x~1', 'refs/heads/side-x^{tree}', 'refs/tags/x', ` refs/heads/${branch}`]) {
        assert.equal((await runBranchAction(git, { kind, name })).ok, false, `${label}: ${name}`)
      }
      assert.deepEqual(snapshot(root), before, label)
      assert.deepEqual(await checkRebaseOnto(git, `refs/heads/${branch}`), { pushed: [] }, label)
      const result = await runBranchAction(git, { kind, name: `refs/heads/${branch}` })
      assert.equal(result.ok, true, `${label}: ${result.message}`)
      assert.ok(result.message.includes(branch), result.message)
      assert.deepEqual(sh(root, 'ls-tree', '--name-only', 'HEAD').split('\n'), ['a.txt', 'x.txt'], label)
    }
  }
})

test('a merge commit names the branch by its short name, or by its full ref when the short one means another ref', async () => {
  const cases: [string, (w: World) => void, string][] = [
    ['refs/heads/topic', nothing, "Merge branch 'topic'"],
    ['refs/remotes/origin/topic', (w) => {
      sh(w.root, 'remote', 'add', 'origin', join(w.root, 'nowhere.git'))
      sh(w.root, 'update-ref', 'refs/remotes/origin/topic', w.t2)
    }, "Merge remote-tracking branch 'origin/topic'"],
    ['refs/heads/heads/evil', (w) => {
      sh(w.root, 'branch', 'heads/evil', w.t2)
      sh(w.root, 'branch', 'evil', w.c1)
    }, "Merge branch 'refs/heads/heads/evil'"]
  ]
  for (const [name, prepare, subject] of cases) {
    const w = world()
    commit(w.root, 'a.txt', 'topic\n', 'match topic')
    prepare(w)
    const result = await runBranchAction(createGit(w.root), { kind: 'merge', name })
    assert.equal(result.ok, true, `${name}: ${result.message}`)
    assert.equal(sh(w.root, 'log', '-1', '--format=%s'), subject, name)
    assert.equal(sh(w.root, 'rev-parse', 'HEAD^2'), w.t2, name)
  }
})

test('checkout of a remote branch as local tracks the remote branch clicked, whatever other remotes hold', async () => {
  const w = world()
  sh(w.root, 'remote', 'add', 'origin', join(w.root, 'origin.git'))
  sh(w.root, 'remote', 'add', 'upstream', join(w.root, 'upstream.git'))
  sh(w.root, 'update-ref', 'refs/remotes/origin/feature', w.t1)
  sh(w.root, 'update-ref', 'refs/remotes/upstream/feature', w.t2)
  const git = createGit(w.root)
  // git switch feature would refuse (two remotes have it) or follow checkout.defaultRemote instead of the click.
  for (const [remote, at, defaultRemote] of [['origin', w.t1, ''], ['upstream', w.t2, 'origin'], ['origin', w.t1, 'upstream']]) {
    if (defaultRemote) sh(w.root, 'config', 'checkout.defaultRemote', defaultRemote)
    const result = await runAction(git, { kind: 'checkout', target: 'feature', track: `refs/remotes/${remote}/feature` })
    assert.equal(result.ok, true, `${remote}: ${result.message}`)
    assert.equal(sh(w.root, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), `${remote}/feature`)
    assert.equal(sh(w.root, 'rev-parse', 'HEAD'), at)
    sh(w.root, 'switch', '-q', 'main')
    sh(w.root, 'branch', '-q', '-D', 'feature')
  }
  for (const track of ['origin/feature', 'refs/remotes/origin/nope', 'refs/tags/x', 'refs/heads/topic', '-x', 42]) {
    await refusedBeforeGit(w, `track ${track}`, (g) => runAction(g, as({ kind: 'checkout', target: 'feature', track })))
  }
  await refusedBeforeGit(w, 'track to a bad name', (g) => runAction(g, { kind: 'checkout', target: 'a b', track: 'refs/remotes/origin/feature' }))
  // The local branch exists already: git refuses to make it again.
  sh(w.root, 'branch', 'feature', w.t1)
  const before = snapshot(w.root)
  assert.equal((await runAction(git, { kind: 'checkout', target: 'feature', track: 'refs/remotes/origin/feature' })).ok, false)
  assert.deepEqual(snapshot(w.root), before)
})

test('branch actions refuse hostile names before git runs', async () => {
  const w = world()
  sh(w.root, 'branch', 'old')
  for (const name of NAMES) {
    const label = JSON.stringify(name)
    await refusedBeforeGit(w, `rename to ${label}`, (git) => runBranchAction(git, { kind: 'rename', name: 'old', newName: as(name) }))
    await refusedBeforeGit(w, `rename ${label}`, (git) => runBranchAction(git, { kind: 'rename', name: as(name), newName: 'fresh' }))
    for (const force of [false, true]) await refusedBeforeGit(w, `delete ${label}`, (git) => runBranchAction(git, { kind: 'delete', name: as(name), force }))
  }
  // Merge and rebase onto targets: branchActions.test.ts "refuse targets that are not one commit". Backups: backup.test.ts.
})

// ---------- 3. A failure is aborted and leaves everything as it was ----------

/** Runs `run` on a fresh world prepared by `prepare` and checks it failed and changed nothing. */
async function failsCleanly(label: string, prepare: (w: World) => void, run: (git: Git, w: World) => Promise<Result>, why = /./): Promise<void> {
  const w = world()
  prepare(w)
  const before = snapshot(w.root)
  const result = await run(createGit(w.root), w)
  assert.equal(result.ok, false, `${label}: ${result.message}`)
  assert.match(result.message, why, label)
  assert.deepEqual(snapshot(w.root), before, label)
}

const nothing = () => {}
/** A local edit to a.txt that every commit touching a.txt would overwrite. */
const editA = (w: World) => writeFileSync(join(w.root, 'a.txt'), 'local a\n')

test('a conflict or a refusal by git aborts the operation and leaves everything as it was', async () => {
  // Checkout and new branch: git refuses to overwrite a local edit or an untracked file.
  await failsCleanly('checkout over a local edit', editA, (git) => runAction(git, { kind: 'checkout', target: 'topic' }))
  await failsCleanly('checkout over an untracked file', (w) => writeFileSync(join(w.root, 't.txt'), 'mine\n'), (git) => runAction(git, { kind: 'checkout', target: 'topic' }))
  await failsCleanly('new branch over a local edit', editA, (git, w) => runAction(git, { kind: 'branch', hash: w.t1, name: 'fresh', checkout: true }))
  await failsCleanly('checkout of a commit that does not exist', nothing, (git) => runAction(git, { kind: 'checkout', target: 'f'.repeat(40) }))
  // Cherry-pick and revert: a conflict on the first or a later commit is aborted.
  await failsCleanly('cherry-pick with a conflict', nothing, (git, w) => runAction(git, { kind: 'cherryPick', hashes: [w.t1] }), /aborted/)
  const t3 = (w: World) => {
    sh(w.root, 'checkout', '-q', 'topic')
    commit(w.root, 'a.txt', 'topic again\n', 't3')
    sh(w.root, 'tag', 't3')
    sh(w.root, 'checkout', '-q', 'main')
  }
  await failsCleanly('cherry-pick with a conflict on the second commit', t3, (git, w) => runAction(git, { kind: 'cherryPick', hashes: [w.t2, sh(w.root, 'rev-parse', 't3')] }), /aborted/)
  await failsCleanly('cherry-pick over a local edit', editA, (git, w) => runAction(git, { kind: 'cherryPick', hashes: [w.t1] }))
  await failsCleanly('revert with a conflict', nothing, (git, w) => runAction(git, { kind: 'revert', hashes: [w.c1] }), /aborted/)
  await failsCleanly('revert of a commit that does not exist', nothing, (git) => runAction(git, { kind: 'revert', hashes: ['f'.repeat(40)] }))
  // Reset --keep refuses rather than overwrite a local edit; a tree is not a commit.
  await failsCleanly('reset --keep over a local edit', editA, (git, w) => runAction(git, { kind: 'reset', hash: w.c1, mode: 'keep' }))
  for (const mode of ['soft', 'mixed', 'hard', 'keep'] as const) {
    await failsCleanly(`reset --${mode} to a tree`, nothing, (git, w) => runAction(git, { kind: 'reset', hash: sh(w.root, 'rev-parse', `${w.c1}^{tree}`), mode }))
  }
  // History rewrites: a conflict, a refusing pre-rebase hook or a commit git cannot make is aborted, with local changes back.
  const dirty = (w: World) => writeFileSync(join(w.root, 'b.txt'), 'local b\n')
  // Main takes topic's a.txt: merging topic then reaches the commit (and its hooks) without a conflict.
  const matchTopic = (w: World) => commit(w.root, 'a.txt', 'topic\n', 'match topic')
  await failsCleanly('drop that makes a later commit conflict', (w) => {
    dirty(w)
    commit(w.root, 'a.txt', 'main again\n', 'c4')
  }, (git, w) => runAction(git, { kind: 'drop', hashes: [w.c3] }), /aborted/)
  const refuseHook = (name: string) => (w: World) => {
    dirty(w)
    writeFileSync(join(w.root, '.git', 'hooks', name), '#!/bin/sh\nexit 1\n')
    chmodSync(join(w.root, '.git', 'hooks', name), 0o755)
  }
  for (const kind of ['squash', 'fixup', 'drop', 'reword'] as const) {
    await failsCleanly(`${kind} refused by a pre-rebase hook`, refuseHook('pre-rebase'), (git, w) =>
      runAction(git, as(kind === 'reword' ? { kind, hash: w.c2, message: 'x' } : { kind, hashes: [w.c3, w.c2], message: 'x' }))
    , /aborted/)
  }
  await failsCleanly('interactive rebase refused by a pre-rebase hook', refuseHook('pre-rebase'), (git, w) =>
    runAction(git, { kind: 'rebase', plan: [{ hash: w.c3, action: 'pick' }, { hash: w.c2, action: 'pick' }] })
  , /aborted/)
  await failsCleanly('reword to a message git refuses', dirty, (git, w) => runAction(git, { kind: 'reword', hash: w.c2, message: 'a\0b' }), /aborted/)
  // Merge and rebase onto: a refusing hook, an untracked file in the way or unrelated histories are aborted with local changes back.
  await failsCleanly('merge refused by a pre-merge-commit hook', (w) => {
    matchTopic(w)
    refuseHook('pre-merge-commit')(w)
  }, (git) => runBranchAction(git, { kind: 'merge', name: 'refs/heads/topic' }), /aborted/)
  await failsCleanly('rebase onto refused by a pre-rebase hook', refuseHook('pre-rebase'), (git) => runBranchAction(git, { kind: 'rebaseOnto', name: 'refs/heads/topic' }), /aborted/)
  const inTheWay = (w: World) => {
    matchTopic(w)
    dirty(w)
    writeFileSync(join(w.root, 't.txt'), 'mine\n')
  }
  await failsCleanly('merge over an untracked file', inTheWay, (git) => runBranchAction(git, { kind: 'merge', name: 'refs/heads/topic' }), /aborted/)
  await failsCleanly('rebase onto over an untracked file', inTheWay, (git) => runBranchAction(git, { kind: 'rebaseOnto', name: 'refs/heads/topic' }), /aborted/)
  await failsCleanly('merge of unrelated histories', (w) => {
    sh(w.root, 'checkout', '-q', '--orphan', 'other')
    sh(w.root, 'rm', '-rq', '--cached', '.')
    writeFileSync(join(w.root, 'z.txt'), 'z\n')
    sh(w.root, 'add', 'z.txt')
    sh(w.root, 'commit', '-qm', 'unrelated')
    sh(w.root, 'checkout', '-qf', 'main')
    dirty(w)
  }, (git) => runBranchAction(git, { kind: 'merge', name: 'refs/heads/other' }), /aborted/)
  // Branch actions: git refuses a taken name, an unmerged branch without force and a branch another worktree uses.
  await failsCleanly('rename to a taken name', nothing, (git) => runBranchAction(git, { kind: 'rename', name: 'topic', newName: 'main' }))
  await failsCleanly('delete of an unmerged branch without force', nothing, (git) => runBranchAction(git, { kind: 'delete', name: 'topic', force: false }))
  await failsCleanly('delete of the current branch', nothing, (git) => runBranchAction(git, { kind: 'delete', name: 'main', force: true }))
  await failsCleanly('delete of a branch that does not exist', nothing, (git) => runBranchAction(git, { kind: 'delete', name: 'gone', force: true }))
  const elsewhere = tempDir('git-log-safety-worktree-')
  await failsCleanly('delete of a branch another worktree has checked out', (w) => {
    sh(w.root, 'worktree', 'add', '-q', join(elsewhere, 'wt'), 'topic')
  }, (git) => runBranchAction(git, { kind: 'delete', name: 'topic', force: true }))
  // Patch: an existing file is not overwritten without asking.
  await failsCleanly('patch over an existing file', (w) => writeFileSync(join(w.root, 'out.patch'), 'mine\n'), async (git, w) => {
    const result = await createPatch(git, w.root, [w.c2], 'out.patch')
    return { ok: result.ok, message: result.ok ? '' : result.reason }
  })
})

test('a cherry-pick of several commits that git refuses at the first leaves no sequencer behind and keeps staged changes', async () => {
  for (const verb of ['cherryPick', 'revert'] as const) {
    const w = world()
    // Staged changes stop git before the first commit; --abort would reset them with the rest.
    writeFileSync(join(w.root, 'b.txt'), 'staged b\n')
    sh(w.root, 'add', 'b.txt')
    const before = snapshot(w.root)
    const result = await runAction(createGit(w.root), as({ kind: verb, hashes: verb === 'revert' ? [w.c2, w.c3] : [w.t1, w.t2] }))
    assert.equal(result.ok, false, verb)
    assert.deepEqual(snapshot(w.root), before, verb)
  }
})

// ---------- 4. Local changes are never lost ----------

/** Every operation on a fresh world with a local edit to b.txt and an untracked notes.txt. */
const everyOperation = (w: World): [string, (git: Git) => Promise<Result>][] => [
  ['checkout of a branch', (git) => runAction(git, { kind: 'checkout', target: 'topic' })],
  ['checkout of a hash', (git) => runAction(git, { kind: 'checkout', target: w.c1 })],
  ['new branch', (git) => runAction(git, { kind: 'branch', hash: w.c1, name: 'fresh', checkout: false })],
  ['new branch, checked out', (git) => runAction(git, { kind: 'branch', hash: w.c1, name: 'fresh', checkout: true })],
  ['new tag', (git) => runAction(git, { kind: 'tag', hash: w.c1, name: 'v1' })],
  ['cherry-pick', (git) => runAction(git, { kind: 'cherryPick', hashes: [w.t2] })],
  ['revert', (git) => runAction(git, { kind: 'revert', hashes: [w.c2] })],
  ['reset --soft', (git) => runAction(git, { kind: 'reset', hash: w.c1, mode: 'soft' })],
  ['reset --mixed', (git) => runAction(git, { kind: 'reset', hash: w.c1, mode: 'mixed' })],
  ['reset --keep', (git) => runAction(git, { kind: 'reset', hash: w.c1, mode: 'keep' })],
  ['undo', (git) => runAction(git, { kind: 'undo', hash: w.c3 })],
  ['squash', (git) => runAction(git, { kind: 'squash', hashes: [w.c3, w.c2], message: 'squashed' })],
  ['fixup', (git) => runAction(git, { kind: 'fixup', hashes: [w.c3] })],
  ['drop', (git) => runAction(git, { kind: 'drop', hashes: [w.c2] })],
  ['reword', (git) => runAction(git, { kind: 'reword', hash: w.c2, message: 'reworded' })],
  ['interactive rebase', (git) => runAction(git, { kind: 'rebase', plan: [{ hash: w.c3, action: 'pick' }, { hash: w.c2, action: 'pick' }] })],
  ['merge', (git) => runBranchAction(git, { kind: 'merge', name: 'refs/heads/topic' })],
  ['rebase onto', (git) => runBranchAction(git, { kind: 'rebaseOnto', name: 'refs/heads/topic' })],
  ['rename', (git) => runBranchAction(git, { kind: 'rename', name: 'topic', newName: 'renamed' })],
  ['delete', (git) => runBranchAction(git, { kind: 'delete', name: 'topic', force: true })],
  ['fetch', (git) => fetchAll(git)],
  ['backup with stash', (git) => createBackup(git, { kind: 'branch', name: 'backup/main-1', target: w.c3, stash: true }).then((r) => ({ ok: r.ok, message: r.ok ? '' : r.message }))],
  ['restore to a backup', (git) => runAction(git, { kind: 'reset', hash: w.c2, mode: 'keep' })],
  ['delete backup', async (git) => {
    sh(w.root, 'tag', 'backup/main-2', w.c2)
    return deleteBackup(git, { kind: 'deleteBackup', ref: 'tag', name: 'backup/main-2', hash: w.c2 })
  }],
  ['create patch', async (git) => {
    const result = await createPatch(git, w.root, [w.c2], 'out.patch')
    return { ok: result.ok, message: result.ok ? '' : result.reason }
  }]
]

test('every operation keeps local changes and untracked files, or refuses and changes nothing', async () => {
  for (const [label] of everyOperation(world())) {
    const w = world()
    // Main takes topic's a.txt so that the merge goes through; rebase onto still stops on c3 and is aborted.
    if (label === 'merge' || label === 'rebase onto') commit(w.root, 'a.txt', 'topic\n', 'match topic')
    writeFileSync(join(w.root, 'b.txt'), 'local b\n')
    writeFileSync(join(w.root, 'notes.txt'), 'my notes\n')
    const before = snapshot(w.root)
    const run = everyOperation(w).find(([name]) => name === label)![1]
    const result = await run(createGit(w.root))
    if (result.ok) {
      assert.equal(readFileSync(join(w.root, 'b.txt'), 'utf8'), 'local b\n', label)
      assert.equal(readFileSync(join(w.root, 'notes.txt'), 'utf8'), 'my notes\n', label)
    } else {
      assert.deepEqual(snapshot(w.root), before, `${label}: ${result.message}`)
    }
  }
  // reset --hard discards local changes by design, behind a confirmation and the stash backup: backup.test.ts.
})

test('a history rewrite whose local changes cannot be re-applied says so and offers no undo', async () => {
  const w = world()
  // c2 added c.txt; dropping it leaves the local edit with nothing to apply to.
  writeFileSync(join(w.root, 'c.txt'), 'local c\n')
  const result = await runAction(createGit(w.root), { kind: 'drop', hashes: [w.c2] })
  assert.equal(result.ok, true, result.message)
  assert.equal((result as { warning?: boolean }).warning, true, result.message)
  assert.match(result.message, /git stash list/)
  assert.equal(result.previousHead, undefined)
  assert.match(sh(w.root, 'stash', 'list'), /autostash/)
  assert.match(sh(w.root, 'stash', 'show', '-p', 'stash@{0}'), /\+local c/)
})

test('rewritten messages keep lines that start with #', async () => {
  const w = world()
  const git = createGit(w.root)
  const reworded = await runAction(git, { kind: 'reword', hash: w.c2, message: 'Fix the parser\n\n#12 is fixed by this\n# keep me' })
  assert.equal(reworded.ok, true, reworded.message)
  assert.equal(sh(w.root, 'log', '-1', '--skip=1', '--format=%B'), 'Fix the parser\n\n#12 is fixed by this\n# keep me')
  const head = sh(w.root, 'rev-parse', 'HEAD')
  const parent = sh(w.root, 'rev-parse', 'HEAD~1')
  const squashed = await runAction(git, { kind: 'squash', hashes: [head, parent], message: `${sh(w.root, 'log', '-1', '--skip=1', '--format=%B')}\n\nc3` })
  assert.equal(squashed.ok, true, squashed.message)
  assert.match(sh(w.root, 'log', '-1', '--format=%B'), /^#12 is fixed by this$/m)
})

test('staged, unstaged and untracked changes come back from rewrites, merge and rebase onto, and lost staging is said', async () => {
  const side = (w: World) => {
    sh(w.root, 'checkout', '-q', '-b', 'side', w.c1)
    commit(w.root, 's.txt', 's\n', 'side')
    sh(w.root, 'checkout', '-q', 'main')
  }
  const runs: [string, (w: World) => void, (git: Git, w: World) => Promise<Result>][] = [
    ['squash', nothing, (git, w) => runAction(git, { kind: 'squash', hashes: [w.c3, w.c2], message: 'squashed' })],
    ['drop', nothing, (git, w) => runAction(git, { kind: 'drop', hashes: [w.c2] })],
    ['reword', nothing, (git, w) => runAction(git, { kind: 'reword', hash: w.c2, message: 'reworded' })],
    ['merge', (w) => commit(w.root, 'a.txt', 'topic\n', 'match topic'), (git) => runBranchAction(git, { kind: 'merge', name: 'refs/heads/topic' })],
    ['rebase onto', side, (git) => runBranchAction(git, { kind: 'rebaseOnto', name: 'refs/heads/side' })],
    ['drop with a conflict', (w) => commit(w.root, 'a.txt', 'main again\n', 'c4'), (git, w) => runAction(git, { kind: 'drop', hashes: [w.c3] })],
    ['merge with a conflict', nothing, (git) => runBranchAction(git, { kind: 'merge', name: 'refs/heads/topic' })],
    ['rebase onto with a conflict', nothing, (git) => runBranchAction(git, { kind: 'rebaseOnto', name: 'refs/heads/topic' })]
  ]
  for (const [label, prepare, run] of runs) {
    const w = world()
    prepare(w)
    commit(w.root, 'e.txt', 'e\n', 'e')
    writeFileSync(join(w.root, 'b.txt'), 'staged b\n')
    writeFileSync(join(w.root, 'n.txt'), 'new n\n')
    sh(w.root, 'add', 'b.txt', 'n.txt')
    writeFileSync(join(w.root, 'e.txt'), 'local e\n')
    writeFileSync(join(w.root, 'u.txt'), 'mine\n')
    const result = await run(createGit(w.root), w)
    assert.equal(result.ok, !label.includes('conflict'), `${label}: ${result.message}`)
    const files = Object.fromEntries(['b.txt', 'n.txt', 'e.txt', 'u.txt'].map((name) => [name, readFileSync(join(w.root, name), 'utf8')]))
    assert.deepEqual(files, { 'b.txt': 'staged b\n', 'n.txt': 'new n\n', 'e.txt': 'local e\n', 'u.txt': 'mine\n' }, label)
    // git's autostash puts changes back unstaged, except new files, which stay added.
    assert.equal(sh(w.root, 'diff', '--cached', '--name-only'), 'n.txt', label)
    assert.match(result.message, /no longer staged/, label)
  }
  // Nothing staged, or only new files: nothing to say.
  const w = world()
  writeFileSync(join(w.root, 'n.txt'), 'new n\n')
  sh(w.root, 'add', 'n.txt')
  assert.doesNotMatch((await runAction(createGit(w.root), { kind: 'drop', hashes: [w.c2] })).message, /staged/)
})

/** Runs `run` with no committer identity in `root` (as on a fresh machine), then puts the test identity back. */
async function withoutIdentity<T>(root: string, run: () => Promise<T> | T): Promise<T> {
  sh(root, 'config', 'user.useConfigOnly', 'true')
  sh(root, 'config', '--unset', 'user.name')
  sh(root, 'config', '--unset', 'user.email')
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  const saved = keys.map((key) => process.env[key])
  keys.forEach((key) => delete process.env[key])
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  try {
    return await run()
  } finally {
    keys.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])))
    sh(root, 'config', 'user.name', 'Tester')
    sh(root, 'config', 'user.email', 'tester@example.com')
  }
}

/** World where merging topic needs a merge commit (and so an identity) and conflicts with nothing; b.txt edited, c.txt staged. */
function mergeable(): World {
  const w = world()
  commit(w.root, 'a.txt', 'topic\n', 'match topic')
  writeFileSync(join(w.root, 'b.txt'), 'local b\n')
  writeFileSync(join(w.root, 'c.txt'), 'staged c\n')
  sh(w.root, 'add', 'c.txt')
  return w
}

test('a merge git stops before it starts gives the local changes back', async () => {
  const w = mergeable()
  // No committer identity: git has already stashed the changes when it finds out.
  const before = snapshot(w.root)
  const result = await withoutIdentity(w.root, () => runBranchAction(createGit(w.root), { kind: 'merge', name: 'refs/heads/topic' }))
  assert.equal(result.ok, false, result.message)
  assert.deepEqual(snapshot(w.root), before)
  // When git cannot store the autostash in the stash list, it drops it anyway: the worker applies it by its hash.
  const locked = mergeable()
  const lockedBefore = snapshot(locked.root)
  writeFileSync(join(locked.root, '.git', 'refs', 'stash.lock'), '')
  const stuck = await withoutIdentity(locked.root, () => runBranchAction(createGit(locked.root), { kind: 'merge', name: 'refs/heads/topic' }))
  rmSync(join(locked.root, '.git', 'refs', 'stash.lock'))
  assert.equal(stuck.ok, false)
  assert.doesNotMatch(stuck.message, /git stash list/)
  assert.deepEqual(snapshot(locked.root), lockedBefore)
})

test('a merge refuses while an earlier merge left local changes under MERGE_AUTOSTASH', async () => {
  const w = mergeable()
  // A merge in a terminal that died after stashing: its changes are only under MERGE_AUTOSTASH.
  await withoutIdentity(w.root, () => terminal(w.root, ['merge', '--no-edit', '--autostash', 'topic']))
  const left = sh(w.root, 'rev-parse', 'MERGE_AUTOSTASH')
  writeFileSync(join(w.root, 'b.txt'), 'newer b\n')
  const before = snapshot(w.root)
  const result = await runBranchAction(createGit(w.root), { kind: 'merge', name: 'refs/heads/topic' })
  assert.equal(result.ok, false, result.message)
  assert.match(result.message, /MERGE_AUTOSTASH/)
  assert.deepEqual(snapshot(w.root), before)
  assert.equal(sh(w.root, 'rev-parse', 'MERGE_AUTOSTASH'), left)
})

test('Undo after an action refuses once HEAD or the files it would reset have moved on', async () => {
  const w = world()
  const git = createGit(w.root)
  const picked = await runGuarded(git, { expectHead: w.c3 }, 'HEAD', () => runAction(git, { kind: 'cherryPick', hashes: [w.t2] }))
  assert.equal(picked.ok, true, picked.message)
  const undo = () => runGuarded(git, { expectHead: picked.head }, 'HEAD', () => runAction(git, { kind: 'reset', hash: picked.previousHead!, mode: 'keep' }))
  // An edit to the file the cherry-pick added: reset --keep refuses rather than lose it.
  writeFileSync(join(w.root, 't.txt'), 'local t\n')
  let before = snapshot(w.root)
  assert.equal((await undo()).ok, false)
  assert.deepEqual(snapshot(w.root), before)
  // A commit made since: the Undo is bound to the HEAD the action left.
  commit(w.root, 't.txt', 'local t\n', 'more')
  before = snapshot(w.root)
  assert.equal((await undo()).ok, false)
  assert.deepEqual(snapshot(w.root), before)
})

// ---------- 5. Pushed commits are reported before a rewrite ----------

test('the rewrite checks name the remote branches that already hold the commits', async () => {
  const w = world()
  const git = createGit(w.root)
  sh(w.root, 'update-ref', 'refs/remotes/origin/main', w.c2)
  const pushed = async (kind: Parameters<typeof checkRewrite>[1], list: string[]) => {
    const check = await checkRewrite(git, kind, list)
    assert.ok(check.ok, `${kind}: ${!check.ok && check.reason}`)
    return check.ok ? check.pushed : []
  }
  assert.deepEqual(await pushed('squash', [w.c3, w.c2]), ['origin/main'])
  assert.deepEqual(await pushed('reword', [w.c2]), ['origin/main'])
  assert.deepEqual(await pushed('drop', [w.c2]), ['origin/main'])
  assert.deepEqual(await pushed('rebase', [w.c2]), ['origin/main'])
  // A single fixup folds into its parent, which is rewritten too.
  assert.deepEqual(await pushed('fixup', [w.c3]), ['origin/main'])
  assert.deepEqual(await pushed('drop', [w.c3]), [])
  assert.deepEqual(await pushed('undo', [w.c3]), [])
  assert.deepEqual(await checkRebaseOnto(git, 'refs/heads/topic'), { pushed: ['origin/main'] })
  sh(w.root, 'update-ref', 'refs/remotes/origin/main', w.c3)
  assert.deepEqual(await pushed('undo', [w.c3]), ['origin/main'])
  assert.deepEqual(await pushed('drop', [w.c3]), ['origin/main'])
})

// ---------- 6. An operation left in progress in a terminal ----------

const resolve = (w: World) => {
  writeFileSync(join(w.root, 'a.txt'), 'resolved by hand\n')
  sh(w.root, 'add', 'a.txt')
}

const IN_PROGRESS: [string, (w: World) => void][] = [
  ['rebase stopped at a conflict', (w) => terminal(w.root, ['rebase', 'topic'])],
  ['rebase stopped at an edit', (w) => terminal(w.root, ['rebase', '-i', w.c1], { GIT_SEQUENCE_EDITOR: 'sed -i s/^pick/edit/' })],
  ['merge with a resolved conflict', (w) => {
    terminal(w.root, ['merge', 'topic'])
    resolve(w)
  }],
  ['cherry-pick with a resolved conflict', (w) => {
    terminal(w.root, ['cherry-pick', w.t1])
    resolve(w)
  }],
  ['revert with a resolved conflict', (w) => {
    terminal(w.root, ['revert', '--no-edit', w.c1])
    resolve(w)
  }],
  ['cherry-pick of two commits, the first committed by hand', (w) => {
    terminal(w.root, ['cherry-pick', w.t1, w.t2])
    resolve(w)
    terminal(w.root, ['commit', '--no-edit'])
  }]
]

for (const [state, start] of IN_PROGRESS) {
  test(`every operation that moves HEAD refuses while a ${state}`, async () => {
    const w = world()
    start(w)
    const before = snapshot(w.root)
    assert.notDeepEqual(before.state, [], 'the terminal left an operation in progress')
    const head = sh(w.root, 'rev-parse', 'HEAD')
    const operations: [string, (git: Git) => Promise<Result>][] = [
      ...everyOperation(w).filter(([label]) => !['new branch', 'new tag', 'rename', 'delete', 'fetch', 'backup with stash', 'delete backup', 'create patch'].includes(label)),
      ['undo of HEAD', (git) => runAction(git, { kind: 'undo', hash: head })],
      ['reset --hard', (git) => runAction(git, { kind: 'reset', hash: w.c1, mode: 'hard' })]
    ]
    for (const [label, run] of operations) {
      const result: ActionResult = await run(createGit(w.root))
      assert.equal(result.ok, false, `${label}: ${result.message}`)
      assert.match(result.message, /in progress|unfinished/, label)
      assert.deepEqual(snapshot(w.root), before, label)
    }
    // Adding a ref leaves HEAD, the index and the files alone: it stays allowed.
    const git = createGit(w.root)
    assert.equal((await runAction(git, { kind: 'tag', hash: w.c1, name: 'v1' })).ok, true)
    assert.equal((await runAction(git, { kind: 'branch', hash: w.c1, name: 'fresh', checkout: false })).ok, true)
    assert.deepEqual({ ...snapshot(w.root), refs: before.refs }, before)
  })
}

test('an action on HEAD that an operation in progress refuses makes no backup and no stash first', async () => {
  const w = world()
  terminal(w.root, ['rebase', '-i', w.c1], { GIT_SEQUENCE_EDITOR: 'sed -i s/^pick/edit/' })
  writeFileSync(join(w.root, 'b.txt'), 'local b\n')
  const before = snapshot(w.root)
  const head = sh(w.root, 'rev-parse', 'HEAD')
  const git = createGit(w.root)
  const backup = { kind: 'branch', name: 'backup/main-1', target: head, stash: true }
  const result = await runGuarded(git, { expectHead: head, backup }, 'HEAD', () => runAction(git, { kind: 'reset', hash: w.c1, mode: 'hard' }))
  assert.equal(result.ok, false)
  assert.match(result.message, /in progress/)
  assert.equal(result.backup, undefined)
  assert.deepEqual(snapshot(w.root), before)
})

test('a cherry-pick that left only its todo list is reported as such, with --quit as the way out', async () => {
  const w = world()
  // Refused at the first commit by a staged change, as earlier versions of the plugin left it.
  writeFileSync(join(w.root, 'b.txt'), 'staged b\n')
  sh(w.root, 'add', 'b.txt')
  terminal(w.root, ['cherry-pick', w.t1, w.t2])
  const before = snapshot(w.root)
  assert.deepEqual(before.state, ['sequencer'])
  const git = createGit(w.root)
  assert.equal((await describeRepo(git, w.root, null)).todoOnly, true)
  const result = await runAction(git, { kind: 'drop', hashes: [w.c2] })
  assert.equal(result.ok, false)
  assert.match(result.message, /git cherry-pick --quit/)
  assert.deepEqual(snapshot(w.root), before)
  // A cherry-pick stopped on a commit is in progress as usual.
  sh(w.root, 'cherry-pick', '--quit')
  sh(w.root, 'reset', '-q')
  terminal(w.root, ['cherry-pick', w.t1])
  assert.equal((await describeRepo(git, w.root, null)).todoOnly, false)
  assert.match((await runAction(git, { kind: 'drop', hashes: [w.c2] })).message, /is in progress/)
})

test('git itself refuses to rename or delete the branch a terminal is rebasing', async () => {
  const w = world()
  terminal(w.root, ['rebase', '-i', w.c1], { GIT_SEQUENCE_EDITOR: 'sed -i s/^pick/edit/' })
  const before = snapshot(w.root)
  const git = createGit(w.root)
  assert.equal((await runBranchAction(git, { kind: 'rename', name: 'main', newName: 'renamed' })).ok, false)
  assert.equal((await runBranchAction(git, { kind: 'delete', name: 'main', force: true })).ok, false)
  assert.deepEqual(snapshot(w.root), before)
  sh(w.root, 'rebase', '--abort')
  sh(w.root, 'checkout', '-q', '-b', 'backup/main-1')
  terminal(w.root, ['rebase', '-i', w.c1], { GIT_SEQUENCE_EDITOR: 'sed -i s/^pick/edit/' })
  const backup = await deleteBackup(git, { kind: 'deleteBackup', ref: 'branch', name: 'backup/main-1', hash: w.c3 })
  assert.equal(backup.ok, false)
  assert.equal(sh(w.root, 'rev-parse', 'refs/heads/backup/main-1'), w.c3)
})

// ---------- Create patch: the file goes inside the repository, never through a link ----------

test('create patch saves only inside the repository, outside its .git, and never through a link', async () => {
  const w = world()
  const git = createGit(w.root)
  const outside = tempDir('git-log-safety-outside-')
  mkdirSync(join(outside, 'dir'))
  writeFileSync(join(outside, 'victim'), 'precious\n')
  symlinkSync(join(outside, 'missing'), join(w.root, 'dangling.patch'))
  symlinkSync(join(outside, 'victim'), join(w.root, 'live.patch'))
  symlinkSync(join(outside, 'dir'), join(w.root, 'linked'))
  const config = readFileSync(join(w.root, '.git', 'config'), 'utf8')
  for (const path of [relative(w.root, join(outside, 'escape.patch')), join(outside, 'abs.patch'), '.git/x.patch', '.git/config', '.GIT/x.patch', 'sub/.git/x.patch', 'dangling.patch', 'live.patch', 'linked/x.patch', 'linked/new/x.patch', 'a\0b.patch']) {
    for (const overwrite of [false, true]) {
      const result = await createPatch(git, w.root, [w.c2], path, overwrite).catch((error: Error) => ({ ok: false as const, reason: `threw ${error.message}` }))
      assert.equal(result.ok, false, `${path}: ${result.ok ? result.path : result.reason}`)
      assert.ok(!result.ok && !result.reason.startsWith('threw'), `${path}: ${!result.ok && result.reason}`)
    }
  }
  assert.deepEqual(readdirSync(outside).sort(), ['dir', 'victim'])
  assert.deepEqual(readdirSync(join(outside, 'dir')), [])
  assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'precious\n')
  assert.equal(readFileSync(join(w.root, '.git', 'config'), 'utf8'), config)
  const saved = await createPatch(git, w.root, [w.c2], join(w.root, 'patches', 'c2.patch'))
  assert.ok(saved.ok && saved.path === join(w.root, 'patches', 'c2.patch'), JSON.stringify(saved))
  // A file where a folder is needed, and a folder where the file would go: a reason, never a failed request.
  for (const [path, overwrite] of [['a.txt/x.patch', false], ['a.txt/x.patch', true], ['patches', false], ['patches', true]] as const) {
    const result = await createPatch(git, w.root, [w.c2], path, overwrite).catch((error: Error) => ({ ok: false as const, reason: `threw ${error.message}`, exists: undefined }))
    assert.ok(!result.ok && !result.reason.startsWith('threw') && !result.exists, `${path}: ${JSON.stringify(result)}`)
  }
  assert.equal(readFileSync(join(w.root, 'a.txt'), 'utf8'), 'main\n')
})

test('create patch refuses a FIFO or another file that is not a regular one, without blocking', async () => {
  const w = world()
  try {
    execFileSync('mkfifo', [join(w.root, 'pipe.patch')])
  } catch {
    return // no mkfifo on this platform
  }
  for (const overwrite of [true, false]) {
    const result = await createPatch(createGit(w.root), w.root, [w.c2], 'pipe.patch', overwrite)
    assert.ok(!result.ok && !result.exists, JSON.stringify(result))
  }
})
