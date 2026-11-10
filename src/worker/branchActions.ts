import type { ActionResult, BranchAction, BranchActionResult } from '../shared/protocol.ts'
import { assertName } from './actions.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'
import { abortedReason, abortRebase, autostashConflict, noteUnstaged, operationInProgress, operationRefusal, pushedTo } from './rebase.ts'
import { noteWarnings } from './warnings.ts'

// Under the 120 s a frame waits, so the fetch's own message arrives.
const NETWORK_TIMEOUT_MS = 100_000
const HASH = /^[0-9a-f]{40}$/

/** Whether the full ref `ref` still names `tip`, the commit a menu or dialog showed; a `tip` that is no hash never does. */
async function stillAt(git: Git, ref: string, tip: unknown): Promise<boolean> {
  if (typeof tip !== 'string' || !HASH.test(tip)) return false
  return (await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`])).stdout.trim() === tip
}

/** Runs a branch action; never throws, a failure is `{ ok: false, message }`. */
export async function runBranchAction(plain: Git, action: BranchAction): Promise<BranchActionResult> {
  const { git, withWarnings } = noteWarnings(plain)
  const attempt = async (): Promise<BranchActionResult> => {
    try {
      return await perform(git, action)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  return withWarnings(await (action?.kind === 'merge' || action?.kind === 'rebaseOnto' ? noteUnstaged(git, attempt) : attempt()))
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
      // -D drops the commits only this branch holds: only while it is where the confirmation showed it. -d keeps
      // them anyway: git refuses unless HEAD or the upstream holds them.
      if (action.force === true && !(await stillAt(git, `refs/heads/${name}`, action.tip))) throw new Error(t('branchMoved', { name }))
      const result = await git.run(['branch', action.force === true ? '-D' : '-d', name])
      if (result.ok) return { ok: true, message: t('branchDeleted', { name }) }
      const reason = lastLines(result.stderr || result.stdout, 4)
      if (action.force !== true && /not fully merged/.test(reason)) return { ok: false, needsForce: true, message: t('notFullyMerged', { name }) }
      throw new Error(reason || t('couldNotDelete', { name }))
    }
    case 'merge':
      return integrate(git, 'merge', action.name, action.tip)
    case 'rebaseOnto':
      return integrate(git, 'rebase', action.name, action.tip)
  }
}

/**
 * `target`, once it is the full name of an existing local or remote branch at a commit. A short name can mean
 * another ref: heads/x is branch x, tags/x tag x, and a tag wins over a branch of the same name.
 */
async function assertTarget(git: Git, target: unknown): Promise<string> {
  const name = typeof target === 'string' ? target : ''
  const exact = /^refs\/(heads|remotes)\//.test(name) && (await git.run(['show-ref', '--verify', '--quiet', name])).ok
  if (!exact || !(await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${name}^{commit}`])).ok) {
    throw new Error(t('notBranchOrCommit', { name }))
  }
  return name
}

/** A full branch name as the panel shows it. */
const shortName = (name: string) => name.replace(/^refs\/(heads|remotes)\//, '')

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

async function integrate(git: Git, kind: 'merge' | 'rebase', target: string, tip: unknown): Promise<BranchActionResult> {
  const busy = await operationRefusal(git)
  if (busy) throw new Error(busy)
  const name = await assertTarget(git, target)
  // Only the commit the menu showed: a fetch or a terminal may have moved the branch since.
  if (!(await stillAt(git, name, tip))) throw new Error(t('branchMoved', { name: shortName(name) }))
  // The next merge would overwrite (or apply on top) changes an earlier one left under MERGE_AUTOSTASH.
  if (kind === 'merge' && (await git.run(['rev-parse', '-q', '--verify', 'MERGE_AUTOSTASH'])).ok) throw new Error(t('mergeAutostashLeft'))
  const previousHead = (await readHead(git)).hash ?? undefined
  // The merge commit's message names what it merged, for good: the short name, when git merge reads it as exactly this
  // ref. Not a branch named like another commit's full hash, nor FETCH_HEAD, which git merge reads from .git/FETCH_HEAD.
  const short = shortName(name)
  const commitOf = async (rev: string) => (await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`])).stdout.trim()
  const exact =
    kind === 'merge' &&
    !short.startsWith('-') &&
    short !== 'FETCH_HEAD' &&
    (await git.run(['rev-parse', '--verify', '-q', '--symbolic-full-name', '--end-of-options', short])).stdout.trim() === name &&
    (await commitOf(short)) === (await commitOf(name))
  // rebase.updateRefs=false: git would also move other branches in the run, which Undo does not restore. Not --no-update-refs: git before 2.38 refuses it.
  const args = kind === 'merge' ? ['merge', '--no-edit', '--autostash', exact ? short : name] : ['-c', 'rebase.updateRefs=false', 'rebase', '--autostash', name]
  const result = await git.run(args)
  if (!result.ok) {
    let kept: string | null = null
    const stuck = kind === 'rebase' ? await abortRebase(git) : null
    if (stuck) throw new Error(stuck)
    if (kind === 'merge') {
      if (await operationInProgress(git)) await git.run(['merge', '--abort'])
      else kept = await returnAutostash(git)
    }
    const reason = abortedReason(result.stderr || result.stdout)
    throw new Error(`${t(kind === 'merge' ? 'mergeFailed' : 'rebaseFailed')}${kept ? ` ${t('changesInCommit', { hash: kept })}` : ''}${reason ? `\n${reason}` : ''}`)
  }
  const message = t(kind === 'merge' ? 'merged' : 'rebased', { name: shortName(name) })
  if (await autostashConflict(git)) return { ok: true, warning: true, message: `${message} ${t('autostashConflict')}` }
  return { ok: true, message, ...(previousHead ? { previousHead } : {}) }
}

/**
 * Gives back the local changes of a merge git stopped after stashing them but before it began (no committer
 * identity): they are left under MERGE_AUTOSTASH. `merge --quit` saves that to the stash list, but drops the ref
 * even when it cannot (git 2.56), so the changes are applied by their hash then. Returns it when they could not be.
 */
async function returnAutostash(git: Git): Promise<string | null> {
  const autostash = (await git.run(['rev-parse', '-q', '--verify', 'MERGE_AUTOSTASH'])).stdout.trim()
  if (!autostash) return null
  await git.run(['merge', '--quit'])
  // Pop only the entry --quit just saved, never one of the user's own.
  const listed = (await git.run(['rev-parse', '-q', '--verify', 'refs/stash'])).stdout.trim() === autostash
  const back = await git.run(listed ? ['stash', 'pop', '--index'] : ['stash', 'apply', '--index', autostash])
  return back.ok ? null : autostash
}

/** `git fetch --all` without pruning; never throws. */
export async function fetchAll(plain: Git): Promise<ActionResult> {
  const { git, withWarnings } = noteWarnings(plain)
  const remotes = await git.run(['remote'])
  if (!remotes.ok || !remotes.stdout.trim()) return { ok: false, message: t('noRemotes') }
  // fetch.prune, remote.<name>.prune and fetch.pruneTags would delete remote branches and local tags, backups included.
  // In parallel (2, not 0: that is the CPU count, 1 on a single core), so a kill takes the per-remote fetches with it;
  // one by one they would go on writing refs.
  const result = await git.run(['-c', 'fetch.parallel=2', 'fetch', '--all', '--no-prune', '--no-prune-tags'], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (result.ok) return withWarnings({ ok: true, message: t('fetched') })
  const reason = lastLines(result.stderr, 4)
  return { ok: false, message: `${t('fetchFailed')}${reason ? `\n${reason}` : ''}` }
}
