import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, mountWorker, test } from 'orca/testing'
import { fromWire, type WireDiff } from '../shared/diffwire.ts'
import * as main from './main.ts'
import { fixture, host } from './testkit.ts'

// Orca refuses a worker's answer over 1 MiB, and counts one of more than 10 000 objects as over it whatever its bytes.
const objects = (value: unknown): number => (value && typeof value === 'object' ? 1 + Object.values(value).reduce((n: number, v) => n + objects(v), 0) : 0)
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('the diff of a long file or of long lines fits in an answer Orca takes', async () => {
  const root = fixture()
  try {
    const lines = (count: number, width: number, changed = -1) => Array.from({ length: count }, (_, i) => (i === changed ? 'changed' : `${i}`.padEnd(width, 'x'))).join('\n') + '\n'
    writeFileSync(join(root, 'long.txt'), lines(15_000, 20))
    writeFileSync(join(root, 'wide.min.js'), lines(300, 10_000))
    sh(root, 'add', '.')
    sh(root, 'commit', '-qm', 'big')
    const added = sh(root, 'rev-parse', 'HEAD')
    writeFileSync(join(root, 'long.txt'), lines(15_000, 20, 7000))
    sh(root, 'commit', '-qam', 'edit')
    const edited = sh(root, 'rev-parse', 'HEAD')
    const worker = await mountWorker(main, { host: host(root) })
    const read = async (input: { from: string; to: string; path: string; wholeFile?: boolean }) => {
      const wire = (await worker.request('range.diff', { root, ...input })) as unknown as WireDiff
      assert.ok(objects(wire) < 10_000, `${objects(wire)} objects`)
      assert.ok(new TextEncoder().encode(JSON.stringify(wire)).length < 1_000_000)
      return fromWire(wire)
    }

    // A new file of 15 000 lines, and the whole of it around a one-line change: every line comes, numbered.
    const fresh = await read({ from: sh(root, 'rev-parse', `${added}^`), to: added, path: 'long.txt' })
    assert.equal(fresh.truncated, false)
    assert.equal(fresh.hunks[0].lines.length, 15_000)
    const whole = await read({ from: added, to: edited, path: 'long.txt', wholeFile: true })
    assert.deepEqual(whole.hunks[0].lines.find((line) => line.kind === '+'), { kind: '+', text: 'changed', new: 7001 })

    // 3 MB of lines: cut at the byte limit, and said so.
    const wide = await read({ from: sh(root, 'rev-parse', `${added}^`), to: added, path: 'wide.min.js' })
    assert.equal(wide.truncated, true)
    assert.ok(wide.hunks[0].lines.length >= 80 && wide.hunks[0].lines.length < 100)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
