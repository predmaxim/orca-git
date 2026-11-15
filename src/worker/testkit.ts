import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from 'orca'
import { mockHost, type MockHost } from 'orca/testing'
import type { NoteDraft } from '../shared/protocol.ts'
import type { NoteStore } from './notes.ts'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A temporary repository with three commits. */
export function fixture(): string {
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

/** A NoteStore on a Map. */
export function memory(): NoteStore {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null),
    set: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async (key) => { map.delete(key) }
  }
}
