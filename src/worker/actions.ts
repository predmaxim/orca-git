import type { ActionRequest, ActionResult, CheckResult, RewriteKind } from '../shared/protocol.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'
import {
  operationInProgress,
  planFor,
  pushedTo,
  rangeHashes,
  readFirstParentHistory,
  runRebase,
  selectRange,
  type HistoryEntry
} from './rebase.ts'

const HASH = /^[0-9a-f]{40}$/

function assertHashes(hashes: unknown): string[] {
  if (!Array.isArray(hashes) || !hashes.length || !hashes.every((h) => typeof h === 'string' && HASH.test(h))) {
    throw new Error(t('invalidSelection'))
  }
  return hashes as string[]
}

export async function assertName(git: Git, name: string, kind: 'branch' | 'tag'): Promise<string> {
  const trimmed = name.trim()
  const args = kind === 'branch' ? ['check-ref-format', '--branch', trimmed] : ['check-ref-format', `refs/tags/${trimmed}`]
  if (!trimmed || trimmed.startsWith('-') || !(await git.run(args)).ok) throw new Error(t(kind === 'branch' ? 'invalidBranchName' : 'invalidTagName', { name: trimmed }))
  return trimmed
}

/** `hashes` sorted oldest first (topological), for cherry-pick. */
export async function oldestFirst(git: Git, hashes: string[]): Promise<string[]> {
  // --no-walk ignores --topo-order and orders by commit time, which ties within one second; walk the history instead.
  const wanted = new Set(hashes)
  const out = await git.out(['rev-list', '--topo-order', '--reverse', ...hashes])
  return out.split(/\r?\n/).filter((hash) => wanted.has(hash))
}

async function sequencer(git: Git, verb: 'cherry-pick' | 'revert', args: string[]): Promise<void> {
  const result = await git.run([verb, ...args], { timeoutMs: 120_000 })
  if (!result.ok) {
    const reason = lastLines(result.stderr || result.stdout, 4)
    if ((await operationInProgress(git)) === verb) await git.run([verb, '--abort'])
    throw new Error(`${t(verb === 'revert' ? 'revertFailed' : 'cherryPickFailed')}${reason ? `\n${reason}` : ''}`)
  }
}

function messagesOf(history: HistoryEntry[]): Map<string, string> {
  return new Map(history.map((entry) => [entry.hash, entry.message]))
}

/** Whether a rewrite of `hashes` is possible, the commits it touches and where they were pushed. */
export async function checkRewrite(git: Git, kind: RewriteKind, hashes: string[]): Promise<CheckResult> {
  try {
    assertHashes(hashes)
    const operation = await operationInProgress(git)
    if (operation) return { ok: false, reason: t('opInProgress', { operation }) }
    const head = await readHead(git)
    if (!head.hash) return { ok: false, reason: t('repoNoCommits') }
    const history = await readFirstParentHistory(git)
    if (kind === 'undo') {
      if (hashes.length !== 1 || hashes[0] !== head.hash) return { ok: false, reason: t('undoOnlyHead') }
      if (!history[0]?.parents.length) return { ok: false, reason: t('undoFirstCommit') }
      return { ok: true, pushed: await pushedTo(git, head.hash), commits: [history[0]] }
    }
    if (kind === 'squash' && hashes.length < 2) return { ok: false, reason: t('squashNeedTwo') }
    if (kind === 'reword' && hashes.length !== 1) return { ok: false, reason: t('rewordNeedOne') }
    const range = selectRange(history, rangeHashes(kind, hashes, history))
    return {
      ok: true,
      pushed: await pushedTo(git, range.commits[0].hash),
      commits: range.commits.map(({ hash, subject, message }) => ({ hash, subject, message }))
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function rewrite(git: Git, action: Extract<ActionRequest, { kind: 'squash' | 'fixup' | 'drop' | 'reword' | 'rebase' }>): Promise<string> {
  const operation = await operationInProgress(git)
  if (operation) throw new Error(t('opInProgress', { operation }))
  const history = await readFirstParentHistory(git)
  const messages = messagesOf(history)
  if (action.kind === 'rebase') {
    const hashes = assertHashes(action.plan?.map((item) => item.hash))
    const range = selectRange(history, hashes)
    const expected = new Set(range.commits.map((c) => c.hash))
    if (hashes.length !== expected.size || !hashes.every((h) => expected.has(h))) {
      throw new Error(t('rebaseBranchChanged'))
    }
    await runRebase(git, range.base, action.plan, messages)
    return t('rebaseFinished')
  }
  const hashes = assertHashes(action.kind === 'reword' ? [action.hash] : action.hashes)
  const range = selectRange(history, rangeHashes(action.kind, hashes, history))
  const message = action.kind === 'squash' || action.kind === 'reword' ? action.message : undefined
  if ((action.kind === 'squash' || action.kind === 'reword') && !message?.trim()) throw new Error(t('commitMessageEmpty'))
  await runRebase(git, range.base, planFor(action.kind, range, hashes, message), messages)
  const n = hashes.length
  switch (action.kind) {
    case 'squash':
      return t('squashed', { count: n })
    case 'fixup':
      return n === 1 ? t('fixedUpPrev') : t('fixedUp', { count: n - 1 })
    case 'drop':
      return t('dropped', { count: n })
    default:
      return t('messageUpdated')
  }
}

export async function runAction(git: Git, action: ActionRequest): Promise<ActionResult> {
  const previousHead = (await readHead(git)).hash ?? undefined
  try {
    const message = await perform(git, action)
    return { ok: true, message, ...(previousHead ? { previousHead } : {}) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function perform(git: Git, action: ActionRequest): Promise<string> {
  switch (action.kind) {
    case 'checkout': {
      const target = action.target?.trim()
      if (!target || target.startsWith('-')) throw new Error(t('invalidCheckoutTarget'))
      if (HASH.test(target)) await git.out(['checkout', '--detach', target, '--'])
      else await git.out(['checkout', target, '--'])
      return t('checkedOut', { target: HASH.test(target) ? target.slice(0, 8) : target })
    }
    case 'branch': {
      const [hash] = assertHashes([action.hash])
      const name = await assertName(git, action.name, 'branch')
      await git.out(action.checkout ? ['checkout', '-b', name, hash, '--'] : ['branch', name, hash])
      return t(action.checkout ? 'createdCheckedOut' : 'createdBranch', { name })
    }
    case 'tag': {
      const [hash] = assertHashes([action.hash])
      const name = await assertName(git, action.name, 'tag')
      await git.out(['tag', name, hash])
      return t('createdTag', { name })
    }
    case 'cherryPick': {
      const hashes = await oldestFirst(git, assertHashes(action.hashes))
      await sequencer(git, 'cherry-pick', hashes)
      return t('cherryPicked', { count: hashes.length })
    }
    case 'revert': {
      const hashes = (await oldestFirst(git, assertHashes(action.hashes))).reverse()
      await sequencer(git, 'revert', ['--no-edit', ...hashes])
      return t('reverted', { count: hashes.length })
    }
    case 'reset': {
      const [hash] = assertHashes([action.hash])
      if (!['soft', 'mixed', 'hard', 'keep'].includes(action.mode)) throw new Error(t('invalidResetMode'))
      await git.out(['reset', `--${action.mode}`, hash, '--'])
      return t('resetDone', { hash: hash.slice(0, 8), mode: action.mode })
    }
    case 'undo': {
      const check = await checkRewrite(git, 'undo', [action.hash])
      if (!check.ok) throw new Error(check.reason)
      await git.out(['reset', '--soft', 'HEAD~1', '--'])
      return t('commitUndone')
    }
    case 'squash':
    case 'fixup':
    case 'drop':
    case 'reword':
    case 'rebase':
      return rewrite(git, action)
    default:
      throw new Error(t('unknownAction', { kind: (action as { kind: string }).kind }))
  }
}
