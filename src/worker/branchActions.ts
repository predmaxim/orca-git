import type { ActionResult, BranchAction, BranchActionResult } from '../shared/protocol.ts'
import { assertName } from './actions.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'
import { autostashConflict, operationInProgress, pushedTo } from './rebase.ts'

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
      const result = await git.run(['branch', action.force === true ? '-D' : '-d', name])
      if (result.ok) return { ok: true, message: t('branchDeleted', { name }) }
      const reason = lastLines(result.stderr || result.stdout, 4)
      if (action.force !== true && /not fully merged/.test(reason)) return { ok: false, needsForce: true, message: t('notFullyMerged', { name }) }
      throw new Error(reason || t('couldNotDelete', { name }))
    }
    case 'merge':
      return integrate(git, 'merge', action.name)
    case 'rebaseOnto':
      return integrate(git, 'rebase', action.name)
  }
}

/** `target` trimmed, once git confirms it names a commit. */
async function assertTarget(git: Git, target: unknown): Promise<string> {
  const name = typeof target === 'string' ? target.trim() : ''
  if (!name || name.startsWith('-') || !(await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${name}^{commit}`])).ok) {
    throw new Error(t('notBranchOrCommit', { name }))
  }
  return name
}

/** Remote branches that already hold commits a rebase of HEAD onto `target` would rewrite. */
export async function checkRebaseOnto(git: Git, target: string): Promise<{ pushed: string[] }> {
  const name = await assertTarget(git, target)
  const rows = (await git.out(['rev-list', '--parents', '--end-of-options', `${name}..HEAD`, '--'])).split('\n').filter(Boolean).map((line) => line.split(' '))
  const range = new Set(rows.map(([hash]) => hash))
  // A remote branch holding any of these commits holds one of the oldest too, so only those are checked.
  const pushed = new Set<string>()
  for (const [hash, ...parents] of rows) {
    if (!parents.some((parent) => range.has(parent))) for (const ref of await pushedTo(git, hash)) pushed.add(ref)
  }
  return { pushed: [...pushed] }
}

async function integrate(git: Git, kind: 'merge' | 'rebase', target: string): Promise<BranchActionResult> {
  const busy = await operationInProgress(git)
  if (busy) throw new Error(t('opInProgress', { operation: busy }))
  const name = await assertTarget(git, target)
  const previousHead = (await readHead(git)).hash ?? undefined
  const args = kind === 'merge' ? ['merge', '--no-edit', '--autostash', name] : ['rebase', '--autostash', name]
  const result = await git.run(args, { timeoutMs: NETWORK_TIMEOUT_MS })
  if (!result.ok) {
    let kept = false
    if (await operationInProgress(git)) await git.run([kind, '--abort'])
    else if (kind === 'merge') kept = await returnAutostash(git)
    const reason = lastLines(result.stderr || result.stdout, 4)
    throw new Error(`${t(kind === 'merge' ? 'mergeFailed' : 'rebaseFailed')}${kept ? ` ${t('changesInStash')}` : ''}${reason ? `\n${reason}` : ''}`)
  }
  const message = t(kind === 'merge' ? 'merged' : 'rebased', { name })
  if (await autostashConflict(git)) return { ok: true, warning: true, message: `${message} ${t('autostashConflict')}` }
  return { ok: true, message, ...(previousHead ? { previousHead } : {}) }
}

/**
 * Gives back the local changes of a merge git stopped after stashing them but before it began (no committer
 * identity): they are left under MERGE_AUTOSTASH, which `merge --quit` saves to the stash list. True when they stay there.
 */
async function returnAutostash(git: Git): Promise<boolean> {
  const autostash = (await git.run(['rev-parse', '-q', '--verify', 'MERGE_AUTOSTASH'])).stdout.trim()
  if (!autostash) return false
  await git.run(['merge', '--quit'])
  // Pop only the entry --quit just saved, never one of the user's own.
  const top = (await git.run(['rev-parse', '-q', '--verify', 'refs/stash'])).stdout.trim()
  return !(top === autostash && (await git.run(['stash', 'pop', '--index'])).ok)
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
