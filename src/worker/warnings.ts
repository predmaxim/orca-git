import type { ActionResult } from '../shared/protocol.ts'
import { t } from '../shared/i18n.ts'
import { GitError, lastLines, type Git } from './git.ts'

/** Commands that change the repository: their warnings are the ones the banner shows. */
const MUTATING = new Set(['checkout', 'switch', 'branch', 'tag', 'reset', 'cherry-pick', 'revert', 'merge', 'rebase', 'fetch', 'stash'])

/** Most warnings one result carries; the rest are counted. */
const SHOWN = 5

/** git's `warning:` and `Warning:` messages in `stderr`, each with the lines that continue it up to a blank line or a hint. */
export function warningsIn(stderr: string): string[] {
  const found: string[][] = []
  let open = false
  for (const line of stderr.split(/\r?\n/)) {
    const text = line.trim()
    if (/^warning:/i.test(text)) {
      found.push([text])
      open = true
    } else if (!text || /^(hint|error|fatal):/i.test(text)) open = false
    else if (open) found[found.length - 1].push(text)
  }
  return found.map((lines) => lines.join(' '))
}

/**
 * `git`, also keeping the warnings of the commands that change something and succeed: `git.out` returns stdout only,
 * and git says there what it left behind (commits on no branch, a branch deleted though only its upstream holds it).
 */
export function noteWarnings(git: Git): { git: Git; withWarnings<R extends ActionResult>(result: R): R } {
  const found: string[] = []
  const run: Git['run'] = async (args, options) => {
    const result = await git.run(args, options)
    let verb = 0
    while (args[verb] === '-c') verb += 2
    if (result.ok && MUTATING.has(args[verb])) found.push(...warningsIn(result.stderr))
    return result
  }
  return {
    git: {
      gitPath: git.gitPath,
      run,
      async out(args, options) {
        const result = await run(args, options)
        // The error createGit's out throws.
        if (!result.ok) throw new GitError(lastLines(result.stderr || result.stdout) || t('gitCommandFailed', { command: args[0] }), result)
        return result.stdout
      }
    },
    withWarnings(result) {
      const unique = [...new Set(found)]
      if (!result.ok || !unique.length) return result
      const shown = unique.length > SHOWN ? [...unique.slice(0, SHOWN), t('moreGitWarnings', { count: unique.length - SHOWN })] : unique
      return { ...result, gitWarnings: shown }
    }
  }
}
