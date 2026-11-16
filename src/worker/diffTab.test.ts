import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { assert, mountWorker, test } from 'orca/testing'
import type { DiffTabState, SelectionFile } from '../shared/protocol.ts'
import { fitWindow } from './diffTab.ts'
import * as main from './main.ts'
import { fixture, host } from './testkit.ts'

/** What a file adds to the JSON of the tab's state: its bytes in UTF-8 and a comma. */
const bytes = (file: SelectionFile) => new TextEncoder().encode(JSON.stringify(file)).length + 1

test('the tab\'s window of files fits the byte limit', () => {
  // Two bytes a character in UTF-8: a window counted in characters would pass the limit.
  const files = Array.from({ length: 3000 }, (_, i): SelectionFile => ({
    status: 'R090',
    path: `${String(i).padStart(4, '0')}/${'я'.repeat(295)}`,
    oldPath: `${String(i).padStart(4, '0')}/${'o'.repeat(295)}`,
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    oldBlob: 'c'.repeat(40),
    newBlob: 'd'.repeat(40)
  }))
  for (const index of [0, 1500, 2999]) {
    const { first, count } = fitWindow(files, index)
    const end = first + count
    assert.ok(first <= index && index < end, `file ${index} is in ${first}..${end}`)
    const total = files.slice(first, end).reduce((sum, file) => sum + bytes(file), 0)
    assert.ok(total <= 900_000, `${total} bytes`)
    // Full: one more file on either side would not fit.
    if (first > 0) assert.ok(total + bytes(files[first - 1]) > 900_000)
    if (end < files.length) assert.ok(total + bytes(files[end]) > 900_000)
  }
  // Around the file: as many after as before, give or take the one taken first.
  const { first, count } = fitWindow(files, 1500)
  assert.ok(Math.abs(1500 - first - (first + count - 1 - 1500)) <= 1)

  const short = files.slice(0, 10).map((file, i) => ({ ...file, path: `${i}.ts`, oldPath: undefined }))
  assert.deepEqual(fitWindow(short, 4), { first: 0, count: 10 })
  // The file opened is there even when it alone passes the limit.
  assert.deepEqual(fitWindow(short, 4, 1), { first: 4, count: 1 })
})

test('every read of the state carries the note until the tab moves', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const [three, two] = execFileSync('git', ['rev-list', '-2', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    const open = { root, hashes: [three, two], path: 'three.txt', to: three }
    const state = async () => (await worker.request('diff.state', { root })) as DiffTabState
    const note = 'abcdef012345'

    // A new tab reads the state when it starts and again on diff.show: both reads have the note, with the same open.
    assert.deepEqual(await worker.request('diff.open', { ...open, note }), { ok: true })
    const first = await state()
    assert.equal(first.reveal, note)
    assert.match(first.open, /^[0-9a-f]{12}$/)
    assert.deepEqual(await state(), first)
    assert.deepEqual(first.files.map((file) => file.path), ['three.txt', 'two.txt'])

    // A file opened without a note drops the one not taken yet; each opening has its own id.
    await worker.request('diff.open', open)
    const plain = await state()
    assert.equal('reveal' in plain, false)
    assert.notEqual(plain.open, first.open)

    assert.deepEqual(await worker.request('diff.open', { ...open, note: 'x' }), { ok: true })
    assert.equal('reveal' in (await state()), false)

    // Stepping to another file drops it too; the tab is still the same opening.
    await worker.request('diff.open', { ...open, note })
    const noted = await state()
    assert.deepEqual(await worker.request('diff.index', { root, index: 1 }), { ok: true })
    const stepped = await state()
    assert.equal(stepped.index, 1)
    assert.equal('reveal' in stepped, false)
    assert.equal(stepped.open, noted.open)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
