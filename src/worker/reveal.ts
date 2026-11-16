// «Show a commit» from another program (the Workflow plugin): Orca has no call from one plugin to another, stops an idle
// worker and drops a hidden panel, so the request waits in a file and the Git panel takes it when it starts. The
// format and the folder are a contract with those programs (docs/reveal.md).
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** A request older than this is dropped: the panel it was for did not open, and a later start must not jump. */
export const REVEAL_TTL = 30_000

/** The request file: in the user's runtime folder (`XDG_RUNTIME_DIR`, else `/run/user/<uid>` when it exists, else a
 * folder of this user in the temp dir); on Windows in the user's local app data. */
export function revealFile(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync,
  platform: string = process.platform): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'orca-git-log', 'reveal.json')
  const uid = process.getuid!()
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'orca-git-log', 'reveal.json')
  return exists(`/run/user/${uid}`) ? join(`/run/user/${uid}`, 'orca-git-log', 'reveal.json') : join(tmpdir(), `orca-git-log-${uid}`, 'reveal.json')
}

// Only a file of this user in a folder closed to others is a request: another user could put one in an open folder.
function ours(file: string, platform: string): boolean {
  if (platform === 'win32') return lstatSync(file).isFile()
  const dir = lstatSync(dirname(file)), st = lstatSync(file)
  const uid = process.getuid!()
  return dir.isDirectory() && dir.uid === uid && (dir.mode & 0o077) === 0 && st.isFile() && st.uid === uid
}

/** The request waiting in `file`, taken once (the file is removed); null when there is none, it is stale, not ours or
 * not a request: `{ "root": "<absolute path in the repository>", "hash": "<4–40 hex>", "at": <ms since epoch> }`. */
export function takeReveal(file = revealFile(), now = Date.now(), platform: string = process.platform): { root: string; hash: string } | null {
  let text: string
  try {
    if (!ours(file, platform)) return null
    text = readFileSync(file, 'utf8')
  } catch {
    return null // none
  }
  rmSync(file, { force: true })
  try {
    const r = JSON.parse(text) as { root?: unknown; hash?: unknown; at?: unknown }
    const fresh = typeof r.at === 'number' && r.at <= now + 5_000 && now - r.at <= REVEAL_TTL
    if (!fresh || typeof r.root !== 'string' || !isAbsolute(r.root) || typeof r.hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(r.hash)) return null
    return { root: r.root, hash: r.hash }
  } catch {
    return null
  }
}
