import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('resolves the focused workspace, pages the log and opens the editor tab', async () => {
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

    assert.deepEqual(await worker.request('tab.open', {}), { ok: true })
    assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'wt-1', path: main.ANCHOR }])
    assert.equal(JSON.parse(readFileSync(join(root, main.ANCHOR), 'utf8')).root, root)
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.orca-git-log\.gitlog$/m)
    assert.equal(sh(root, 'status', '--porcelain'), '')

    await assert.rejects(worker.request('log.page', { root: tmpdir(), filter: {}, skip: 0 }))
    assert.deepEqual(worker.refusals, [])
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

test('opening the tab with a reveal posts it and hands it over once', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const hash = sh(root, 'rev-parse', 'HEAD')
    const reveal = { root, hashes: [hash], path: 'one.txt' }
    assert.deepEqual(await worker.request('tab.open', { reveal }), { ok: true })
    assert.deepEqual(worker.posts.at(-1), { event: 'tab.reveal', payload: reveal })
    assert.deepEqual(await worker.request('tab.take', { root }), reveal)
    assert.equal(await worker.request('tab.take', { root }), null)

    const bad = await worker.request('tab.open', { reveal: { root, hashes: ['nothex'] } })
    assert.equal(bad.ok, false)
    assert.equal(await worker.request('tab.take', { root }), null)
    const many = await worker.request('tab.open', { reveal: { root, hashes: Array(501).fill(hash) } })
    assert.deepEqual(many, { ok: false, reason: 'Select at most 500 commits.' })
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a reveal from another repository than the focused workspace opens nothing', async () => {
  const root = fixture()
  const other = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const reveal = { root: other, hashes: [sh(other, 'rev-parse', 'HEAD')] }
    const result = await worker.request('tab.open', { reveal })
    assert.deepEqual(result, { ok: false, reason: 'These commits are from another repository than the focused workspace. Nothing was opened.' })
    assert.deepEqual(h.callsOf('editor.open'), [])
    assert.deepEqual(worker.posts, [])
    assert.equal(await worker.request('tab.take', { root }), null)
    assert.equal(await worker.request('tab.take', { root: other }), null)
    assert.ok(!existsSync(join(root, main.ANCHOR)))
    await worker.deactivate()
  } finally {
    for (const dir of [root, other]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
