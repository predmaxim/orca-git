import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { assert, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { DiffTabState } from '../shared/protocol.ts'
import * as main from './main.ts'
import { diffKey } from './notes.ts'
import { fixture, host } from './testkit.ts'

// Orca stops an idle worker and starts a new one on the next request: a new mountWorker on the same host (the same storage) is that new worker.

const commits = (root: string) => execFileSync('git', ['rev-list', '-3', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
const remove = (root: string) => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

test('the Diff tab shows the same files after the worker restarts', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const [three, two] = commits(root)
    const open = { root, hashes: [three, two], path: 'three.txt', to: three }
    let worker = await mountWorker(main, { host: h })
    assert.deepEqual(await worker.request('diff.open', open), { ok: true })
    const before = (await worker.request('diff.state', { root })) as DiffTabState
    assert.deepEqual(h.data().storage[diffKey(root)], { root, hashes: [three, two], path: 'three.txt', to: three, open: before.open })
    await worker.deactivate()

    worker = await mountWorker(main, { host: h })
    const after = (await worker.request('diff.state', { root })) as DiffTabState
    assert.deepEqual(after, before)
    assert.deepEqual(after.files.map((file) => file.path), ['three.txt', 'two.txt'])
    assert.equal('reveal' in after, false)

    // A note the tab may not have scrolled to yet comes back too, with the same open: the tab knows whether it did.
    assert.deepEqual(await worker.request('diff.open', { ...open, note: 'abcdef012345' }), { ok: true })
    const noted = await worker.request('diff.state', { root })
    await worker.deactivate()
    worker = await mountWorker(main, { host: h })
    assert.deepEqual(await worker.request('diff.state', { root }), noted)
    await worker.deactivate()
  } finally {
    remove(root)
  }
})

test('the restarted tab opens on the file it was moved to', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const [three, two] = commits(root)
    let worker = await mountWorker(main, { host: h })
    await worker.request('diff.open', { root, hashes: [three, two], path: 'three.txt', to: three })
    assert.deepEqual(await worker.request('diff.index', { root, index: 1 }), { ok: true })
    await worker.deactivate()

    worker = await mountWorker(main, { host: h })
    const state = (await worker.request('diff.state', { root })) as DiffTabState
    assert.equal(state.index, 1)
    assert.equal(state.files[state.index].path, 'two.txt')
    await worker.deactivate()
  } finally {
    remove(root)
  }
})

test('a tab that steps or is gone to before it reads the state of a restarted worker is not lost', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const [three, two] = commits(root)
    let worker = await mountWorker(main, { host: h })
    await worker.request('diff.open', { root, hashes: [three, two], path: 'three.txt', to: three })
    await worker.deactivate()

    // The tab stays on screen and does not read diff.state again: the new worker's first request is its step.
    worker = await mountWorker(main, { host: h })
    assert.deepEqual(await worker.request('diff.index', { root, index: 1 }), { ok: true })
    assert.deepEqual(worker.posts.at(-1), { event: 'diff.current', payload: { root, path: 'two.txt' } })
    assert.equal((h.data().storage[diffKey(root)] as { path: string }).path, 'two.txt')
    await worker.deactivate()

    worker = await mountWorker(main, { host: h })
    assert.deepEqual(await worker.request('diff.focus', { root }), { ok: true })
    assert.equal(((await worker.request('diff.state', { root })) as DiffTabState).index, 1)
    await worker.deactivate()
  } finally {
    remove(root)
  }
})

test('a stored selection whose commits are gone shows the placeholder', async () => {
  const root = fixture()
  try {
    const [three] = commits(root)
    const kept = (over: Record<string, JsonValue>): JsonValue => ({ root, hashes: [three], path: 'three.txt', to: three, open: 'abcdef012345', ...over })
    const read = async (value: JsonValue) => {
      const worker = await mountWorker(main, { host: host(root, {}, { [diffKey(root)]: value }) })
      try {
        return { state: await worker.request('diff.state', { root }), logs: worker.logs }
      } finally {
        await worker.deactivate()
      }
    }

    // The value as it is kept shows; the same one with its commit gone does not, and the log says why.
    assert.equal(((await read(kept({}))).state as DiffTabState).files[0].path, 'three.txt')
    const gone = await read(kept({ hashes: ['f'.repeat(40)] }))
    assert.equal(gone.state, null)
    assert.equal(gone.logs.length, 1)

    const garbage: Record<string, JsonValue>[] = [
      { hashes: three },
      { hashes: [three.slice(0, 7)] },
      { hashes: Array(501).fill(three) },
      { hashes: [] },
      { root: '/elsewhere' },
      { path: 1 },
      { open: null }
    ]
    // Each refused value is logged once; nothing kept is not.
    for (const over of garbage) {
      const { state, logs } = await read(kept(over))
      assert.equal(state, null, JSON.stringify(over).slice(0, 80))
      assert.equal(logs.length, 1, JSON.stringify(over).slice(0, 80))
    }
    const { state, logs } = await read('garbage')
    assert.equal(state, null)
    assert.deepEqual(logs, [`Diff tab not restored for ${root}: invalid value`])
    const worker = await mountWorker(main, { host: host(root) })
    assert.equal(await worker.request('diff.state', { root }), null)
    assert.deepEqual(worker.logs, [])
    await worker.deactivate()
  } finally {
    remove(root)
  }
})
