import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { matchWorkspace } from './repo.ts'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function fixture(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-worker-')))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'core.autocrlf', 'false')
  for (const name of ['one', 'two', 'three']) {
    writeFileSync(join(root, `${name}.txt`), name)
    sh(root, 'add', '.')
    sh(root, 'commit', '-qm', name)
  }
  return root
}

function host(root: string) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'remote', kind: 'worktree', name: 'demo', path: '/nowhere/demo', branch: 'main', hostId: 'ssh-1' },
          { id: 'wt-1', kind: 'worktree', name: 'demo', path: root, branch: 'refs/heads/main', hostId: null }
        ],
        truncated: false
      },
      'editor.open': { opened: true }
    }
  })
}

test('resolves the focused workspace, pages the log and runs an action', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const resolved = await worker.request('repo.resolve', {})
    assert.equal(resolved.ok, true)
    assert.equal(resolved.ok && resolved.repo.root, root)
    assert.equal(resolved.ok && resolved.repo.workspaceId, 'wt-1')
    assert.equal(resolved.ok && resolved.repo.head.branch, 'main')

    const page = await worker.request('log.page', { root, filter: {}, skip: 0, limit: 2 })
    assert.deepEqual(page.commits.map((c: { subject: string }) => c.subject), ['three', 'two'])
    assert.equal(page.hasMore, true)

    const [newest, middle] = page.commits
    const run = await worker.request('action.run', { root, action: { kind: 'drop', hashes: [middle.hash] } })
    assert.equal(run.ok, true, run.message)
    assert.equal(run.previousHead, newest.hash)
    assert.deepEqual(worker.posts.at(-1), { event: 'repo.changed', payload: { root } })

    await assert.rejects(worker.request('log.page', { root: tmpdir(), filter: {}, skip: 0 }))
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('action.run and branch.run check the HEAD the dialog showed and make the backup first', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const [head, parent] = sh(root, 'rev-list', '-2', 'HEAD').split('\n')
    const name = 'backup/main-20261110-1432'
    const stale = await worker.request('action.run', { root, action: { kind: 'drop', hashes: [head] }, expectHead: parent, backup: { kind: 'branch', name, target: parent } })
    assert.equal(stale.ok, false)
    const stuck = await worker.request('branch.run', { root, action: { kind: 'rebaseOnto', name: 'main' }, expectHead: parent })
    assert.equal(stuck.ok, false)
    // A stash goes only with a hard reset.
    const stashed = await worker.request('action.run', { root, action: { kind: 'drop', hashes: [head] }, expectHead: head, backup: { kind: 'branch', name, target: head, stash: true } })
    assert.equal(stashed.ok, false)
    assert.deepEqual(await worker.request('backup.check', { root, kind: 'branch', name }), { ok: true })
    assert.deepEqual(await worker.request('reset.check', { root, target: parent }), { dirty: false, overwritten: [], repositories: [] })
    assert.equal(sh(root, 'rev-parse', 'HEAD'), head)
    assert.equal(sh(root, 'for-each-ref', 'refs/heads/backup'), '')
    const run = await worker.request('action.run', { root, action: { kind: 'drop', hashes: [head] }, expectHead: head, backup: { kind: 'branch', name, target: head } })
    assert.equal(run.ok, true, run.message)
    assert.equal(run.backup, name)
    assert.equal(sh(root, 'rev-parse', name), head)
    const deleted = await worker.request('backup.delete', { root, action: { kind: 'deleteBackup', ref: 'branch', name, hash: head } })
    assert.equal(deleted.ok, true, deleted.message)
    assert.equal(sh(root, 'for-each-ref', 'refs/heads/backup'), '')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a workspace that only exists on a remote host is reported as unsupported', async () => {
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'r', kind: 'worktree', name: 'demo', path: '/home/me/demo', branch: 'main', hostId: 'ssh-1' }],
          truncated: false
        }
      }
    })
  })
  const resolved = await worker.request('repo.resolve', {})
  assert.equal(resolved.ok, false)
  assert.match(resolved.ok ? '' : resolved.reason, /Remote workspaces/)
  await worker.deactivate()
})

const ANCHOR = '.orca-git-log.gitdiff'

function diffState(root: string) {
  const [to, from] = sh(root, 'rev-list', '-2', 'HEAD').split('\n')
  return {
    root,
    files: [
      { status: 'R', path: 'one.txt', oldPath: 'uno.txt', from, to },
      { status: 'A', path: 'three.txt', from: null, to }
    ],
    index: 1
  }
}

test('opening a file shows it in the Diff tab of the workspace that holds its repository', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const state = diffState(root)
    assert.deepEqual(await worker.request('diff.open', state), { ok: true })
    assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'wt-1', path: ANCHOR }])
    assert.deepEqual(JSON.parse(readFileSync(join(root, ANCHOR), 'utf8')), { root, workspaceId: 'wt-1' })
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.orca-git-log\.gitdiff$/m)
    assert.equal(sh(root, 'status', '--porcelain'), '')
    assert.deepEqual(worker.posts.at(-1), { event: 'diff.show', payload: { root } })
    assert.deepEqual(await worker.request('diff.state', { root }), state)
    assert.equal(await worker.request('diff.state', { root: tmpdir() }), null)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a Diff tab state with bad files, hashes or index opens nothing', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const good = diffState(root)
    const file = good.files[0]
    const bad: object[] = [
      { files: 'one.txt' },
      { files: [] },
      { files: Array(2001).fill(file) },
      { files: [null] },
      { files: [, file] },
      { files: [{ ...file, path: '' }] },
      { files: [{ ...file, path: 'a\0b' }] },
      { files: [{ ...file, path: 1 }] },
      { files: [{ ...file, oldPath: '' }] },
      { files: [{ ...file, oldPath: 'a\0b' }] },
      { files: [{ ...file, status: 'X' }] },
      { files: [{ ...file, status: 'MM' }] },
      { files: [{ ...file, from: 'HEAD' }] },
      { files: [{ ...file, to: null }] },
      { files: [{ ...file, to: file.to.toUpperCase() }] },
      { index: -1 },
      { index: 2 },
      { index: 0.5 },
      { index: '0' }
    ]
    for (const change of bad) {
      const result = await worker.request('diff.open', { ...good, index: 0, ...change })
      assert.deepEqual(result, { ok: false, reason: 'Invalid list of files.' }, JSON.stringify(change).slice(0, 100))
    }
    assert.deepEqual(h.callsOf('editor.open'), [])
    assert.deepEqual(worker.posts, [])
    assert.ok(!existsSync(join(root, ANCHOR)))
    assert.ok(!readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').includes(ANCHOR))
    assert.equal(await worker.request('diff.state', { root }), null)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a repository that no workspace holds opens no Diff tab', async () => {
  const root = fixture()
  const other = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const result = await worker.request('diff.open', diffState(other))
    assert.deepEqual(result, { ok: false, reason: 'No open workspace holds this repository. Nothing was opened.' })
    assert.deepEqual(h.callsOf('editor.open'), [])
    assert.deepEqual(worker.posts, [])
    assert.ok(!existsSync(join(other, ANCHOR)) && !existsSync(join(root, ANCHOR)))
    assert.ok(!readFileSync(join(other, '.git', 'info', 'exclude'), 'utf8').includes(ANCHOR))
    assert.equal(await worker.request('diff.state', { root: other }), null)
    await worker.deactivate()
  } finally {
    for (const dir of [root, other]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('an anchor name taken by anything but the plugin\'s own anchor opens nothing and stays as it was', async () => {
  const root = fixture()
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-outside-')))
  try {
    const anchor = join(root, ANCHOR)
    const target = join(outside, 'notes.txt')
    writeFileSync(target, 'keep')
    const exclude = join(root, '.git', 'info', 'exclude')
    const before = readFileSync(exclude, 'utf8')
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const taken: [string, () => void][] = [
      ['a file of the user', () => writeFileSync(anchor, 'my notes\n')],
      ['an anchor of another repository', () => writeFileSync(anchor, JSON.stringify({ root: outside }))],
      ['a hard link', () => linkSync(target, anchor)],
      ['a symlink', () => symlinkSync(target, anchor)],
      ['a dangling symlink', () => symlinkSync(join(outside, 'missing'), anchor)],
      ['a directory', () => mkdirSync(anchor)]
    ]
    for (const [name, make] of taken) {
      make()
      const content = lstatSync(anchor).isFile() ? readFileSync(anchor, 'utf8') : null
      const result = await worker.request('diff.open', diffState(root))
      assert.deepEqual(result, { ok: false, reason: `${anchor} already exists and is not the plugin's file. Nothing was opened.` }, name)
      if (content !== null) assert.equal(readFileSync(anchor, 'utf8'), content, name)
      rmSync(anchor, { recursive: true, force: true })
    }
    assert.equal(readFileSync(target, 'utf8'), 'keep')
    assert.equal(readFileSync(exclude, 'utf8'), before)
    assert.deepEqual(h.callsOf('editor.open'), [])
    assert.deepEqual(worker.posts, [])
    assert.equal(await worker.request('diff.state', { root }), null)
    await worker.deactivate()
  } finally {
    for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a FIFO under the anchor name is refused without blocking', async () => {
  const root = fixture()
  try {
    const anchor = join(root, ANCHOR)
    try {
      execFileSync('mkfifo', [anchor])
    } catch {
      return // no mkfifo on this platform
    }
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const result = await worker.request('diff.open', diffState(root))
    assert.deepEqual(result, { ok: false, reason: `${anchor} already exists and is not the plugin's file. Nothing was opened.` })
    assert.ok(lstatSync(anchor).isFIFO())
    assert.ok(!readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').includes(ANCHOR))
    assert.deepEqual(h.callsOf('editor.open'), [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a workspace the anchor cannot be created in says why and opens nothing', async () => {
  if (userInfo().uid === 0) return // root writes into a read-only folder anyway
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    chmodSync(root, 0o555)
    const result = await worker.request('diff.open', diffState(root))
    chmodSync(root, 0o755)
    assert.deepEqual(result, { ok: false, reason: `Could not create ${join(root, ANCHOR)}: EACCES. Nothing was opened.` })
    assert.ok(!existsSync(join(root, ANCHOR)))
    assert.ok(!readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').includes(ANCHOR))
    assert.deepEqual(h.callsOf('editor.open'), [])
    await worker.deactivate()
  } finally {
    chmodSync(root, 0o755)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the plugin\'s own anchor is not rewritten on the next file', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    assert.deepEqual(await worker.request('diff.open', diffState(root)), { ok: true })
    const anchor = join(root, ANCHOR)
    const content = readFileSync(anchor, 'utf8')
    utimesSync(anchor, 1_000_000, 1_000_000)
    assert.deepEqual(await worker.request('diff.open', { ...diffState(root), index: 0 }), { ok: true })
    assert.equal(statSync(anchor).mtimeMs, 1_000_000_000)
    assert.equal(readFileSync(anchor, 'utf8'), content)
    assert.equal(h.callsOf('editor.open').length, 2)
    assert.equal((await worker.request('diff.state', { root }))?.index, 0)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('stepping to another file in the Diff tab updates its state and tells the sidebar', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    await worker.request('diff.open', diffState(root))
    const posts = worker.posts.length
    assert.deepEqual(await worker.request('diff.index', { root, index: 0 }), { ok: true })
    assert.deepEqual(worker.posts.at(-1), { event: 'diff.current', payload: { root, path: 'one.txt' } })
    assert.equal((await worker.request('diff.state', { root }))?.index, 0)
    const bad: any[] = [{ root, index: 2 }, { root, index: -1 }, { root, index: 0.5 }, { root, index: '1' }, { root: tmpdir(), index: 0 }, { index: 0 }]
    for (const input of bad) assert.deepEqual(await worker.request('diff.index', input), { ok: false }, JSON.stringify(input))
    assert.equal(worker.posts.length, posts + 1)
    assert.equal((await worker.request('diff.state', { root }))?.index, 0)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('same-named workspaces are told apart by terminal titles, then by a previous choice', () => {
  const a = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-a-')))
  const b = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-b-')))
  mkdirSync(`${a}-sibling`)
  try {
    const list = [
      { id: 'a', name: 'main', path: a.replace(/\\/g, '/'), branch: 'main', hostId: 'local' },
      { id: 'a2', name: 'main', path: `${a}-sibling`, branch: 'main', hostId: 'local' },
      { id: 'b', name: 'main', path: b, branch: 'main', hostId: 'local' },
      { id: 'other', name: 'main', path: b, branch: 'feature', hostId: 'local' }
    ]
    const msys = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
    const context = (title: string) => ({ branch: 'main', displayName: 'main', terminals: [{ id: 't', title }] })

    assert.deepEqual(matchWorkspace(context(`MINGW64:${msys(b)}`), list), { workspace: list[2] })
    assert.deepEqual(matchWorkspace(context(`pwsh ${a}`), list), { workspace: list[0] })
    const unclear = matchWorkspace(context('Copilot'), list)
    assert.ok(unclear && 'ambiguous' in unclear)
    assert.deepEqual(unclear.ambiguous.map((w) => w.id), ['a', 'a2', 'b'])
    assert.deepEqual(matchWorkspace(context('Copilot'), list, 'b'), { workspace: list[2] })
  } finally {
    rmSync(a, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(`${a}-sibling`, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(b, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
