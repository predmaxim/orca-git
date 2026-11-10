import { accessSync, constants, statSync } from 'node:fs'
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
