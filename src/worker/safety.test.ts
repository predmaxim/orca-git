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
  ['merge', (git) => runBranchAction(git, { kind: 'merge', name: 'topic' })],
  ['rebase onto', (git) => runBranchAction(git, { kind: 'rebaseOnto', name: 'topic' })],
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
      assert.match(result.message, /in progress/, label)
      assert.deepEqual(snapshot(w.root), before, label)
    }
    // Adding a ref leaves HEAD, the index and the files alone: it stays allowed.
    const git = createGit(w.root)
    assert.equal((await runAction(git, { kind: 'tag', hash: w.c1, name: 'v1' })).ok, true)
    assert.equal((await runAction(git, { kind: 'branch', hash: w.c1, name: 'fresh', checkout: false })).ok, true)
    assert.deepEqual({ ...snapshot(w.root), refs: before.refs }, before)
  })
}
