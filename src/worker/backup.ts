import type { ActionResult } from '../shared/protocol.ts'
import { assertName } from './actions.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { readHead } from './log.ts'

const HASH = /^[0-9a-f]{40}$/

type Made = { ok: true; name: string; stash?: string }
type Refused = { ok: false; message: string }

const refused = (error: unknown): Refused => ({ ok: false, message: error instanceof Error ? error.message : String(error) })

const refName = (kind: 'branch' | 'tag', name: string) => `${kind === 'branch' ? 'refs/heads' : 'refs/tags'}/${name}`

/** The commit `ref` (a full ref name) points at, or null when there is no such ref. */
async function tipOf(git: Git, ref: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`])
  return result.ok ? result.stdout.trim() : null
}

/**
 * Creates the backup branch or tag `name` at `target`, never moving an existing ref; with `stash`, first
 * snapshots the uncommitted changes into the stash without touching the work tree. Never throws.
 */
export async function createBackup(git: Git, request: unknown): Promise<Made | Refused> {
  try {
    const { kind, name, target, stash } = (request ?? {}) as Record<string, unknown>
    if ((kind !== 'branch' && kind !== 'tag') || typeof name !== 'string' || typeof target !== 'string' || !HASH.test(target)) {
      throw new Error(t('backupInvalid'))
    }
    const checked = await assertName(git, name, kind)
    if (await tipOf(git, refName(kind, checked))) throw new Error(t('backupExists', { name: checked }))
    // stash create writes only objects; the stash ref changes after the backup ref exists.
    const snapshot = stash === true ? (await git.out(['stash', 'create'])).trim() : ''
    await git.out(kind === 'branch' ? ['branch', '--no-track', checked, target] : ['tag', checked, target])
    if (!snapshot) return { ok: true, name: checked }
    const branch = (await readHead(git)).branch ?? 'HEAD'
    await git.out(['stash', 'store', '-m', `Git plugin backup before reset --hard (${branch})`, snapshot])
    return { ok: true, name: checked, stash: snapshot }
  } catch (error) {
    return refused(error)
  }
}

/** What `action.run` and `branch.run` take besides the action, as a frame sent it. */
export interface Guard {
  /** The HEAD the confirmation showed; the action runs only while HEAD is still there. */
  expectHead?: unknown
  backup?: unknown
}

/**
 * Runs `run` only while HEAD is still `expectHead` and after the backup, when one is asked for, is made.
 * The backup must point at `tip`: HEAD, or the branch an action deletes. A failed action still reports
 * the backup it left.
 */
export async function runGuarded<R extends ActionResult>(git: Git, guard: Guard, tip: 'HEAD' | { branch: string }, run: () => Promise<R>): Promise<R | ActionResult> {
  const { expectHead, backup } = guard
  if (expectHead === undefined && backup === undefined) return run()
  let made: Made | undefined
  try {
    const head = (await readHead(git)).hash
    if (expectHead !== undefined && (typeof expectHead !== 'string' || !HASH.test(expectHead) || expectHead !== head)) throw new Error(t('repoChanged'))
    if (backup !== undefined) {
      const target = tip === 'HEAD' ? head : await tipOf(git, `refs/heads/${await assertName(git, tip.branch, 'branch')}`)
      if (!target || (backup as { target?: unknown })?.target !== target) throw new Error(t('repoChanged'))
      const result = await createBackup(git, backup)
      if (!result.ok) return result
      made = result
    }
  } catch (error) {
    return refused(error)
  }
  const result = await run()
  return made ? { ...result, backup: made.name, ...(made.stash ? { stash: made.stash } : {}) } : result
}

