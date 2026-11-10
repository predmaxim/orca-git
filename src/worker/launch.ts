import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { t } from '../shared/i18n.ts'

/**
 * Where a bare `name` is looked for, in order: the absolute PATH entries only. Empty, `.` and other relative
 * entries are skipped, so the git of the folder it runs in (a cloned repository) is never started. On Windows each
 * folder is tried with the .com and .exe of PATHEXT in its order: CreateProcess starts nothing else without a shell.
 */
export function gitCandidates(name: string, env: Record<string, string | undefined>, platform: string): string[] {
  const path = platform === 'win32' ? win32 : posix
  const extensions = platform === 'win32' && !path.extname(name) ? (env.PATHEXT || '.COM;.EXE').split(';').filter((ext) => /^\.(com|exe)$/i.test(ext)) : ['']
  return (env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => (platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter((dir) => dir && path.isAbsolute(dir))
    .flatMap((dir) => extensions.map((ext) => path.join(dir, name + ext)))
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
 * The absolute path of the git the Git executable setting names: an absolute path as it is, a bare name from PATH
 * (`gitCandidates`). A relative path is refused: it would start whatever that path holds in the repository.
 */
export function resolveGit(setting: string, env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  if ((platform === 'win32' ? win32 : posix).isAbsolute(setting)) {
    if (runnable(setting)) return setting
    throw new Error(t('gitNotRunnable', { path: setting }))
  }
  if (platform === 'win32' ? /[\\/:]/.test(setting) : setting.includes('/')) throw new Error(t('gitPathRelative', { path: setting }))
  const found = gitCandidates(setting, env, platform).find(runnable)
  if (!found) throw new Error(t('gitNotOnPath', { name: setting }))
  return found
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
