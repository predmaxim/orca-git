import assert from 'node:assert/strict'
import { lstatSync } from 'node:fs'
import { test } from 'node:test'
import { gitEnv, resolveGit, sessionRuntimeDir, type FolderStat } from './launch.ts'

const folder = (over: Partial<{ dir: boolean; link: boolean; uid: number; mode: number }> = {}): FolderStat => {
  const { dir = true, link = false, uid = 1000, mode = 0o40700 } = over
  return { isDirectory: () => dir, isSymbolicLink: () => link, uid, mode }
}

test('a worker without the session gets the user\'s runtime folder back for git', () => {
  assert.equal(sessionRuntimeDir({}, 1000, () => folder()), '/run/user/1000')
  // The session already reaches the worker: nothing is added.
  assert.equal(sessionRuntimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000, () => folder()), null)
  assert.equal(sessionRuntimeDir({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, 1000, () => folder()), null)
  // Windows has no uid; no folder, a file, a link, another user's folder or one open to others is not trusted.
  assert.equal(sessionRuntimeDir({}, undefined, () => folder()), null)
  assert.equal(sessionRuntimeDir({}, 1000, () => null), null)
  assert.equal(sessionRuntimeDir({}, 1000, () => folder({ dir: false })), null)
  assert.equal(sessionRuntimeDir({}, 1000, () => folder({ link: true })), null)
  assert.equal(sessionRuntimeDir({}, 1000, () => folder({ uid: 0 })), null)
  assert.equal(sessionRuntimeDir({}, 1000, () => folder({ mode: 0o40755 })), null)
})

test('git gets XDG_RUNTIME_DIR when the worker has none and the folder is the user\'s', (t) => {
  const saved = { xdg: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS }
  delete process.env.XDG_RUNTIME_DIR
  delete process.env.DBUS_SESSION_BUS_ADDRESS
  try {
    const uid = process.getuid?.()
    const stat = (path: string) => {
      try {
        return lstatSync(path)
      } catch {
        return null
      }
    }
    // The worker's own value stays as it is.
    process.env.XDG_RUNTIME_DIR = '/custom'
    assert.equal(gitEnv(resolveGit('git')).XDG_RUNTIME_DIR, '/custom')
    delete process.env.XDG_RUNTIME_DIR
    if (sessionRuntimeDir({}, uid, stat) === null) return t.skip(`no /run/user/${uid} of this user here`)
    assert.equal(gitEnv(resolveGit('git')).XDG_RUNTIME_DIR, `/run/user/${uid}`)
  } finally {
    if (saved.xdg !== undefined) process.env.XDG_RUNTIME_DIR = saved.xdg
    if (saved.bus !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = saved.bus
  }
})
