import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from 'orca'
import { hostError, mockHost, type MockHost } from 'orca/testing'
import type { NoteDraft } from '../shared/protocol.ts'
import type { NoteStore } from './notes.ts'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A temporary repository with three commits, in a folder whose name starts with `prefix`. */
export function fixture(prefix = 'git-log-worker-'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
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

/** A host whose local workspace `wt-1` is at `root`; `results` go over the defaults, `storage` seeds the plugin's storage. */
export function host(root: string, results: Record<string, unknown> = {}, storage?: Record<string, JsonValue>): MockHost {
  return mockHost({
    storage,
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'remote', kind: 'worktree', name: 'demo', path: '/nowhere/demo', branch: 'main', hostId: 'ssh-1' },
          { id: 'wt-1', kind: 'worktree', name: 'demo', path: root, branch: 'refs/heads/main', hostId: null }
        ],
        truncated: false
      },
      'editor.open': { opened: true },
      ...results
    }
  })
}

/** A valid draft: new side of src/a.ts, lines 3-4, with `over` on top. */
export function draft(over: Record<string, unknown> = {}): NoteDraft {
  return { path: 'src/a.ts', side: 'new', blob: 'b'.repeat(40), rev: 'c'.repeat(40), start: { line: 3, col: 0 }, end: { line: 4, col: 1 }, quote: 'x\ny', body: 'why?', ...over } as NoteDraft
}

/** The plugin's storage as `results` of `host`: values in `data`, and a write `refuse` picks fails as Orca fails a value over 262144 bytes. */
export function refusingStorage(refuse: (key: string, value: any) => boolean, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'storage.get': ({ key }: { key: string }) => ({ value: key in data ? structuredClone(data[key]) : null }),
    'storage.set': ({ key, value }: { key: string; value: unknown }) => {
      if (refuse(key, value)) throw hostError('too_large', 'value exceeds 262144 bytes')
      data[key] = structuredClone(value)
      return { ok: true }
    },
    'storage.delete': ({ key }: { key: string }) => {
      delete data[key]
      return { ok: true }
    }
  }
}

/** A NoteStore on a Map. */
export function memory(): NoteStore {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null),
    set: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async (key) => { map.delete(key) }
  }
}
