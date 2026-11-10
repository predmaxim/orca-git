import type { ActionResult } from '../shared/protocol.ts'
import { t } from '../shared/i18n.ts'
import { stdoutOf, subcommand, type Git } from './git.ts'

/** Commands that change the repository: their warnings are the ones the banner shows. */
const MUTATING = new Set(['checkout', 'switch', 'branch', 'tag', 'reset', 'cherry-pick', 'revert', 'merge', 'rebase', 'fetch', 'stash'])

/** Most warnings one result carries; the rest are counted. */
const SHOWN = 5

/** git starts its own warnings exactly so, at the start of a line; a hook's `WARNING:` is not one of them. */
const WARNING = /^(warning|Warning): /

/** The line-ending conversion (core.autocrlf, .gitattributes) git warns about once per file: shown as one count. */
const LINE_ENDINGS = /\b(CR)?LF will be replaced by (CR)?LF\b/

/**
 * git's `warning: ` and `Warning: ` messages in `stderr`. A message git wraps goes on, indented or in lower case,
 * after a line that ends without `.`, `:`, `!` or `?`; a blank line, a `hint: ` or anything else ends it.
 */
export function warningsIn(stderr: string): string[] {
  const found: string[] = []
  let open = false
  for (const line of stderr.split(/\r?\n/)) {
    if (WARNING.test(line)) {
      found.push(line.trim())
      open = true
    } else if (open && /^(\s+\S|[a-z'"])/.test(line) && !/^\s*\w+: /.test(line) && !/[.:!?]$/.test(found[found.length - 1])) {
      found[found.length - 1] += ` ${line.trim()}`
    } else open = false
  }
  return found
}

/**
 * `git`, also keeping the warnings of the commands that change something and succeed: `git.out` returns stdout only,
 * and git says there what it left behind (commits on no branch, a branch deleted though only its upstream holds it).
 */
export function noteWarnings(git: Git): { git: Git; withWarnings<R extends ActionResult>(result: R): R } {
  const found: string[] = []
  const run: Git['run'] = async (args, options) => {
    const result = await git.run(args, options)
    if (result.ok && MUTATING.has(subcommand(args))) found.push(...warningsIn(result.stderr))
    return result
  }
  return {
    git: {
      gitPath: git.gitPath,
      root: git.root,
      run,
      out: async (args, options) => stdoutOf(args, await run(args, options))
    },
    withWarnings(result) {
      const all = [...new Set(found)]
      const endings = all.filter((warning) => LINE_ENDINGS.test(warning)).length
      const unique = [...all.filter((warning) => !LINE_ENDINGS.test(warning)), ...(endings ? [t('lineEndingWarnings', { count: endings })] : [])]
      if (!result.ok || !unique.length) return result
      const shown = unique.length > SHOWN ? [...unique.slice(0, SHOWN), t('moreGitWarnings', { count: unique.length - SHOWN })] : unique
      return { ...result, gitWarnings: shown }
    }
  }
}
