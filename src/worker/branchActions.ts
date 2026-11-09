import type { ActionResult, BranchAction, BranchActionResult } from '../shared/protocol.ts'
import { assertName } from './actions.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'
import { operationInProgress } from './rebase.ts'

const NETWORK_TIMEOUT_MS = 120_000

/** Runs a branch action; never throws, a failure is `{ ok: false, message }`. */
export async function runBranchAction(git: Git, action: BranchAction): Promise<BranchActionResult> {
  try {
    return await perform(git, action)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function perform(git: Git, action: BranchAction): Promise<BranchActionResult> {
  switch (action.kind) {
    case 'rename': {
      const name = await assertName(git, action.name, 'branch')
      const newName = await assertName(git, action.newName, 'branch')
      await git.out(['branch', '-m', name, newName])
      return { ok: true, message: t('branchRenamed', { name, newName }) }
    }
    case 'delete': {
      const name = await assertName(git, action.name, 'branch')
      if (!(await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).ok) throw new Error(t('noLocalBranch', { name }))
      if ((await readHead(git)).branch === name) throw new Error(t('cannotDeleteCurrent'))
      const result = await git.run(['branch', action.force ? '-D' : '-d', name])
      if (result.ok) return { ok: true, message: t('branchDeleted', { name }) }
      const reason = lastLines(result.stderr || result.stdout, 4)
      if (!action.force && /not fully merged/.test(reason)) return { ok: false, needsForce: true, message: t('notFullyMerged', { name }) }
      throw new Error(reason || t('couldNotDelete', { name }))
    }
    case 'merge':
      return integrate(git, 'merge', action.name)
    case 'rebaseOnto':
      return integrate(git, 'rebase', action.name)
  }
}

async function integrate(git: Git, kind: 'merge' | 'rebase', target: string): Promise<BranchActionResult> {
  const busy = await operationInProgress(git)
  if (busy) throw new Error(t('opInProgress', { operation: busy }))
  const name = target.trim()
  if (!name || name.startsWith('-') || !(await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${name}^{commit}`])).ok) {
    throw new Error(t('notBranchOrCommit', { name }))
  }
  const previousHead = (await readHead(git)).hash ?? undefined
  const args = kind === 'merge' ? ['merge', '--no-edit', '--autostash', name] : ['rebase', '--autostash', name]
  const result = await git.run(args, { timeoutMs: NETWORK_TIMEOUT_MS })
  if (!result.ok) {
    if (await operationInProgress(git)) await git.run([kind, '--abort'])
    const reason = lastLines(result.stderr || result.stdout, 4)
    throw new Error(`${t(kind === 'merge' ? 'mergeFailed' : 'rebaseFailed')}${reason ? `\n${reason}` : ''}`)
  }
  const message = t(kind === 'merge' ? 'merged' : 'rebased', { name })
  // git exits 0 when the autostash does not apply cleanly: the changes stay in the stash and the tree has conflicts.
  if ((await git.run(['diff', '--name-only', '--diff-filter=U', '--'])).stdout.trim()) return { ok: true, warning: true, message: `${message} ${t('autostashConflict')}` }
  return { ok: true, message, ...(previousHead ? { previousHead } : {}) }
}

/** `git fetch --all` without pruning; never throws. */
export async function fetchAll(git: Git): Promise<ActionResult> {
  const remotes = await git.run(['remote'])
  if (!remotes.ok || !remotes.stdout.trim()) return { ok: false, message: t('noRemotes') }
  const result = await git.run(['fetch', '--all'], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (result.ok) return { ok: true, message: t('fetched') }
  const reason = lastLines(result.stderr, 4)
  return { ok: false, message: `${t('fetchFailed')}${reason ? `\n${reason}` : ''}` }
}
