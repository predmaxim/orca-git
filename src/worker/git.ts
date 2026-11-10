import { execFile } from 'node:child_process'
import { t } from '../shared/i18n.ts'
import { gitEnv, resolveGit } from './launch.ts'

export interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** stdout as git wrote it, with `bytes: true`. */
  bytes?: Uint8Array
}

export interface GitOptions {
  env?: Record<string, string>
  timeoutMs?: number
  /** Also keep stdout as bytes (`GitResult.bytes`): output that need not be UTF-8, such as a patch. */
  bytes?: boolean
  /** Written to git's stdin, which is then closed. */
  input?: string
}

export interface Git {
  /** The git executable this runner launches. */
  readonly gitPath: string
  /** The repository's top level, where git runs: paths git prints relative to it resolve against it. */
  readonly root: string
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

/** The stdout of `args`' `result`, or the readable error `out` throws when git failed. */
export function stdoutOf(args: string[], result: GitResult): string {
  if (!result.ok) throw new GitError(lastLines(result.stderr || result.stdout) || t('gitCommandFailed', { command: args[0] }), result)
  return result.stdout
}

/** Subcommands the worker only reads with. */
const READ_ONLY = new Set(['cat-file', 'check-ref-format', 'config', 'diff', 'diff-tree', 'for-each-ref', 'format-patch', 'hash-object', 'log', 'ls-files', 'ls-tree', 'remote', 'rev-list', 'rev-parse', 'show', 'show-ref', 'status', 'symbolic-ref', 'version'])

/** The subcommand of `args`, past any `-c name=value` in front. */
export const subcommand = (args: string[]) => args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? ''

/**
 * How long git may run before it is killed (0: never). A read is killed after 60 s; anything else may be half way
 * through changing the repository, so it runs to the end unless the caller sets a limit (fetch, waiting on the network).
 */
export const timeoutFor = (args: string[], options: GitOptions = {}): number => options.timeoutMs ?? (READ_ONLY.has(subcommand(args)) ? 60_000 : 0)

export function createGit(root: string, gitPath = 'git'): Git {
  // An absolute path: given a bare name, Windows starts the git.exe of the repository (the cwd) before PATH's.
  const file = resolveGit(gitPath)
  const env = gitEnv(file)
  const run = (args: string[], options: GitOptions = {}) =>
    new Promise<GitResult>((resolve) => {
      const child = execFile(
        file,
        ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args],
        {
          cwd: root,
          // Every message goes in with -m or -F; with the editor ":" git never waits for one.
          env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_EDITOR: ':', ...options.env },
          maxBuffer: 64 * 1024 * 1024,
          timeout: timeoutFor(args, options),
          windowsHide: true,
          encoding: options.bytes ? 'buffer' : 'utf8'
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : null) : 0
          // String() of a Buffer decodes it as UTF-8, as execFile does for 'utf8'.
          const err = String(stderr)
          // Killed (a signal, a time limit, the output cap) rather than refused: what it was changing may be half done.
          const stopped = Boolean((error as any)?.signal) || (error as any)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          const text = err || (error && !stopped ? error.message : '')
          const note = stopped ? `${text.trimEnd()}\n${t('gitStopped', { command: subcommand(args) })}`.trimStart() : text
          resolve({ ok: !error, code, stdout: String(stdout), stderr: note, ...(options.bytes ? { bytes: stdout } : {}) })
        }
      )
      if (options.input !== undefined) child.stdin?.end(options.input)
    })
  return {
    gitPath: file,
    root,
    run,
    out: async (args, options) => stdoutOf(args, await run(args, options))
  }
}
