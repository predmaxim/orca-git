import { execFile } from 'node:child_process'
import { t } from '../shared/i18n.ts'
import { gitEnv, resolveGit } from './launch.ts'

export interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface GitOptions {
  env?: Record<string, string>
  timeoutMs?: number
}

export interface Git {
  /** The git executable this runner launches. */
  readonly gitPath: string
  run(args: string[], options?: GitOptions): Promise<GitResult>
  /** Runs and returns stdout, throwing a readable Error when git fails. */
  out(args: string[], options?: GitOptions): Promise<string>
}

export class GitError extends Error {
  constructor(message: string, readonly result: GitResult) {
    super(message)
  }
}

export function lastLines(text: string, count = 6): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n')
}

export function createGit(root: string, gitPath = 'git'): Git {
  // An absolute path: given a bare name, Windows starts the git.exe of the repository (the cwd) before PATH's.
  const file = resolveGit(gitPath)
  const env = gitEnv(file)
  const run = (args: string[], options: GitOptions = {}) =>
    new Promise<GitResult>((resolve) => {
      execFile(
        file,
        ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args],
        {
          cwd: root,
          env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
          maxBuffer: 64 * 1024 * 1024,
          timeout: options.timeoutMs ?? 60_000,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : null) : 0
          resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : '')) })
        }
      )
    })
  return {
    gitPath: file,
    run,
    async out(args, options) {
      const result = await run(args, options)
      if (!result.ok) throw new GitError(lastLines(result.stderr || result.stdout) || t('gitCommandFailed', { command: args[0] }), result)
      return result.stdout
    }
  }
}
