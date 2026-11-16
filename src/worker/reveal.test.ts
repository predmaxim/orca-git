import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { REVEAL_TTL, revealFile, takeReveal } from './reveal.ts'
import { fixture, host } from './testkit.ts'

/** A private request folder as the runtime dir gives it, and its request file. */
function box(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'git-log-reveal-')), 'orca-git-log')
  mkdirSync(dir, { mode: 0o700 })
  return join(dir, 'reveal.json')
}
const ask = (file: string, body: object) => writeFileSync(file, JSON.stringify(body))

test('the request file: the runtime folder, else /run/user/<uid>, else a folder of this user in the temp dir; Windows: local app data', () => {
  const uid = process.getuid!()
  assert.equal(revealFile({ XDG_RUNTIME_DIR: '/run/x' }, () => false, 'linux'), '/run/x/orca-git-log/reveal.json')
  assert.equal(revealFile({}, (p) => p === `/run/user/${uid}`, 'linux'), `/run/user/${uid}/orca-git-log/reveal.json`)
  assert.equal(revealFile({}, () => false, 'linux'), join(tmpdir(), `orca-git-log-${uid}`, 'reveal.json'))
  assert.equal(revealFile({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, () => false, 'win32'), join('C:\\Users\\u\\AppData\\Local', 'orca-git-log', 'reveal.json'))
})

test('a request is taken once; a stale, malformed or foreign one is dropped', () => {
  const file = box(), now = 1_000_000
  ask(file, { root: '/r', hash: 'ABCDEF1', at: now - 1000 })
  assert.deepEqual(takeReveal(file, now), { root: '/r', hash: 'ABCDEF1' })
  assert.equal(existsSync(file), false)
  assert.equal(takeReveal(file, now), null) // taken
  for (const bad of [{ root: '/r', hash: 'abc1234', at: now - REVEAL_TTL - 1 }, { root: '/r', hash: 'abc1234', at: now + 60_000 }, { root: 'r', hash: 'abc1234', at: now },
    { root: '/r', hash: 'HEAD', at: now }, { root: '/r', hash: 'abc', at: now }, { root: '/r', at: now }]) {
    ask(file, bad)
    assert.equal(takeReveal(file, now), null, JSON.stringify(bad))
    assert.equal(existsSync(file), false) // a bad one goes too
  }
  writeFileSync(file, '{')
  assert.equal(takeReveal(file, now), null)
  // A folder open to others is not ours: the file there is no request, and it stays.
  ask(file, { root: '/r', hash: 'abc1234', at: now })
  chmodSync(join(file, '..'), 0o755)
  assert.equal(takeReveal(file, now), null)
  assert.equal(existsSync(file), true)
})

test('reveal.take: the repository of the request and the commit by its full hash, once; a commit that is not there gives nothing', async () => {
  const root = fixture()
  const file = box()
  const saved = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = join(file, '..', '..')
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const full = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' }).trim()
    assert.equal(await worker.request('reveal.take', {}), null)
    ask(file, { root, hash: full.slice(0, 7), at: Date.now() })
    const got = (await worker.request('reveal.take', {})) as { repo: { root: string }; hash: string }
    assert.equal(got.repo.root, root)
    assert.equal(got.hash, full)
    assert.equal(await worker.request('reveal.take', {}), null)
    ask(file, { root, hash: 'deadbeef', at: Date.now() })
    assert.equal(await worker.request('reveal.take', {}), null)
    ask(file, { root: join(root, 'missing'), hash: full, at: Date.now() })
    assert.equal(await worker.request('reveal.take', {}), null)
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = saved
  }
})
