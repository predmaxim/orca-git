import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { t } from '../shared/i18n.ts'

const unquote = (entry: string, platform: string) => (platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry)

/**
 * Whether `path` starts at a root. On Windows only a drive (`C:\`) or UNC (`\\server\`) path does: `\tools` and `/x`
 * hang off the current drive, and `C:x` off that drive's current folder.
 */
const rooted = (path: string, platform: string) => (platform === 'win32' ? /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path) : path.startsWith('/'))

/**
 * The entries of a PATH value that start at a root. Empty, `.` and other relative entries are dropped: they name
 * folders of wherever a program starts, which for git is the repository.
 */
function absoluteEntries(value: string, platform: string): string[] {
  return value.split((platform === 'win32' ? win32 : posix).delimiter).filter((entry) => rooted(unquote(entry, platform), platform))
}

/**
 * The files the Git executable setting may mean, in order: a full path as it is, a bare name in each absolute PATH
 * folder. On Windows a name without an extension is tried with the .com and .exe of PATHEXT in its order, as Windows
 * runs it: CreateProcess starts nothing else without a shell.
 */
export function gitCandidates(name: string, env: Record<string, string | undefined>, platform: string): string[] {
  const path = platform === 'win32' ? win32 : posix
  const extensions = platform === 'win32' && !path.extname(name) ? (env.PATHEXT || '.COM;.EXE').split(';').filter((ext) => /^\.(com|exe)$/i.test(ext)) : ['']
  const files = rooted(name, platform) ? [name] : absoluteEntries(env.PATH ?? '', platform).map((dir) => path.join(unquote(dir, platform), name))
  return files.flatMap((file) => extensions.map((ext) => file + ext))
}

function runnable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The absolute path of the git the Git executable setting names (`gitCandidates`). A relative path is refused: it
 * would start whatever that path holds in the repository.
 */
export function resolveGit(setting: string, env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const full = rooted(setting, platform)
  if (!full && (platform === 'win32' ? /[\\/:]/.test(setting) : setting.includes('/'))) throw new Error(t('gitPathRelative', { path: setting }))
  const found = gitCandidates(setting, env, platform).find(runnable)
  if (found) return found
  throw new Error(full ? t('gitNotRunnable', { path: setting }) : t('gitNotOnPath', { name: setting }))
}

/** Per git executable, the variables that point it at another repository (`git rev-parse --local-env-vars`). */
const localVars = new Map<string, Set<string>>()

/**
 * The worker's environment without what would send git to another repository or add config to every call: the
 * variables `git rev-parse --local-env-vars` lists (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_COUNT…) and
 * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>. Asked once per executable, outside any repository.
 */
export function gitEnv(git: string) {
  let drop = localVars.get(git)
  if (!drop) {
    const bare = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
    try {
      drop = new Set(execFileSync(git, ['rev-parse', '--local-env-vars'], { cwd: tmpdir(), env: bare, encoding: 'utf8', timeout: 10_000, windowsHide: true }).split(/\r?\n/).filter(Boolean))
    } catch (error) {
      throw new Error(t('gitProbeFailed', { path: git, error: error instanceof Error ? error.message : String(error) }))
    }
    localVars.set(git, drop)
  }
  const keep = drop
  // Upper case: Windows reads variable names in any case.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !keep.has(key.toUpperCase()) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(key)))
}
