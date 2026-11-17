import { watch, type FSWatcher } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { Git } from './git.ts'

// Only these paths (relative to a git dir) change what the log shows; a linked worktree has its own under worktrees/<name>,
// next to its index, which a plain `git status` there rewrites.
const RELEVANT = /^(worktrees\/[^/]+\/)?(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs|rebase-merge|rebase-apply)(\/|$)/

export function isRelevant(file: string | null): boolean {
  if (!file) return true
  const path = file.split(sep).join('/')
  return !path.endsWith('.lock') && RELEVANT.test(path)
}

export interface RepoWatcher {
  close(): void
}

/** Calls `onChange` (debounced) when refs, HEAD or a sequencer state of the repository change. */
export async function watchRepo(git: Git, root: string, onChange: () => void, delayMs = 400): Promise<RepoWatcher> {
  const [gitDir, commonDir] = (await git.out(['rev-parse', '--git-dir', '--git-common-dir']))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((dir) => resolve(root, dir))
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, delayMs)
  }
  const watchers: FSWatcher[] = []
  const dirs = [commonDir]
  if (gitDir && gitDir !== commonDir && relative(commonDir, gitDir).startsWith('..')) dirs.push(gitDir)
  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, file) => {
        if (isRelevant(file ? file.toString() : null)) fire()
      })
      watcher.on('error', () => watcher.close())
      watchers.push(watcher)
    } catch {
      // Recursive watching is unavailable (older Linux Node): the panel still refreshes on focus.
    }
  }
  return {
    close() {
      clearTimeout(timer)
      watchers.forEach((w) => w.close())
    }
  }
}
