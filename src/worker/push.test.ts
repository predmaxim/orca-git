import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createGit } from './git.ts'
import { checkPush, runPush } from './push.ts'
import type { PushPlan } from '../shared/protocol.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(root: string, file: string, message: string): string {
  writeFileSync(join(root, file), `${message}\n`)
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', message)
  return sh(root, 'rev-parse', 'HEAD')
}

/** A bare origin with main at one commit, and clones of it ready to commit. */
function origin(...names: string[]): { bare: string; clones: string[] } {
  const base = mkdtempSync(join(tmpdir(), 'git-log-push-'))
  dirs.push(base)
  const bare = join(base, 'origin.git')
  sh(base, 'init', '-q', '--bare', '-b', 'main', bare)
  const clone = (name: string) => {
    sh(base, 'clone', '-q', bare, name)
    const root = join(base, name)
    sh(root, 'config', 'user.name', 'Tester')
    sh(root, 'config', 'user.email', 'tester@example.com')
    sh(root, 'config', 'commit.gpgsign', 'false')
    return root
  }
  const seed = clone('seed')
  commit(seed, 'base.txt', 'base')
  sh(seed, 'push', '-q', 'origin', 'main')
  return { bare, clones: names.map(clone) }
}

async function plan(root: string): Promise<PushPlan> {
  const check = await checkPush(createGit(root))
  assert.ok(check.ok, check.ok ? '' : check.reason)
  return check.plan
}

const request = (p: PushPlan, extra: object = {}) => ({ branch: p.branch, hash: p.hash, remote: p.remote, remoteBranch: p.remoteBranch, setUpstream: p.publish, ...extra })

test('push sends the commits the check listed to the upstream, never one made after the check', async () => {
  const { bare, clones: [mine] } = origin('mine')
  commit(mine, 'one.txt', 'one')
  commit(mine, 'two.txt', 'two')
  const p = await plan(mine)
  assert.deepEqual([p.publish, p.remote, p.remoteBranch, p.count], [false, 'origin', 'main', 2])
  assert.deepEqual(p.commits.map((c) => c.subject), ['two', 'one'])
  commit(mine, 'three.txt', 'three')
  assert.equal((await runPush(createGit(mine), request(p))).ok, false)
  sh(mine, 'reset', '-q', '--hard', 'HEAD~1')
  const done = await runPush(createGit(mine), request(p))
  assert.equal(done.ok, true, done.message)
  assert.equal(sh(bare, 'rev-parse', 'main'), p.hash)
})

test('a branch with no upstream is published under the name chosen, with the upstream set', async () => {
  const { bare, clones: [mine] } = origin('mine')
  sh(mine, 'switch', '-q', '-c', 'topic')
  commit(mine, 'topic.txt', 'topic')
  const p = await plan(mine)
  assert.deepEqual([p.publish, p.remote, p.remoteBranch, p.count, p.remotes], [true, 'origin', 'topic', 1, ['origin']])
  const done = await runPush(createGit(mine), request(p, { remoteBranch: 'feature/topic' }))
  assert.equal(done.ok, true, done.message)
  assert.equal(sh(bare, 'rev-parse', 'feature/topic'), p.hash)
  assert.equal(sh(mine, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/feature/topic')
  // From now on it goes to its upstream, though the names differ (push.default=simple would refuse a plain git push).
  const next = await plan(mine)
  assert.deepEqual([next.publish, next.remoteBranch, next.count, next.remoteTip], [false, 'feature/topic', 0, p.hash])
})

test('a diverged remote is reported, a force with lease replaces it after a backup, and a stale lease is refused', async () => {
  const { bare, clones: [mine, theirs] } = origin('mine', 'theirs')
  commit(mine, 'x.txt', 'x')
  assert.equal((await runPush(createGit(mine), request(await plan(mine)))).ok, true)
  sh(mine, 'commit', '-q', '--amend', '-m', 'x rewritten')
  const rejected = await runPush(createGit(mine), request(await plan(mine)))
  assert.deepEqual([rejected.ok, rejected.diverged], [false, true])
  const p = await plan(mine)
  assert.deepEqual(p.remoteOnly.map((c) => c.subject), ['x'])
  const oldTip = p.remoteTip!
  const backup = { kind: 'branch', name: 'backup/origin-main', target: oldTip }
  const forced = await runPush(createGit(mine), request(p, { force: { expect: oldTip }, backup }))
  assert.equal(forced.ok, true, forced.message)
  assert.equal(forced.backup, 'backup/origin-main')
  assert.equal(sh(mine, 'rev-parse', 'backup/origin-main'), oldTip)
  assert.equal(sh(bare, 'rev-parse', 'main'), p.hash)
  // Someone pushes after this clone's last fetch: the lease on what this clone saw no longer holds.
  sh(theirs, 'fetch', '-q', 'origin')
  sh(theirs, 'reset', '-q', '--hard', 'origin/main')
  const theirTip = commit(theirs, 'y.txt', 'y')
  sh(theirs, 'push', '-q', 'origin', 'main')
  sh(mine, 'commit', '-q', '--amend', '-m', 'x rewritten again')
  const stale = await plan(mine)
  const refused = await runPush(createGit(mine), request(stale, { force: { expect: stale.remoteTip } }))
  assert.equal(refused.ok, false)
  assert.equal(sh(bare, 'rev-parse', 'main'), theirTip)
})

test('push refuses a detached HEAD, a remote the repository lacks, names git would expand and a force that sets the upstream', async () => {
  const { clones: [mine] } = origin('mine')
  commit(mine, 'one.txt', 'one')
  const p = await plan(mine)
  for (const bad of [{ remote: 'nope' }, { remoteBranch: '@{upstream}' }, { remoteBranch: '-x' }, { branch: 'refs/heads/main' }, { hash: 'HEAD' }, { setUpstream: true, force: { expect: null } }]) {
    assert.equal((await runPush(createGit(mine), request(p, bad))).ok, false, JSON.stringify(bad))
  }
  sh(mine, 'switch', '-q', '--detach')
  const check = await checkPush(createGit(mine))
  assert.equal(check.ok, false)
})
