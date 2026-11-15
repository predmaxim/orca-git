// Push of the current branch: `push.check` reads what a push would send and where, `push.run` sends exactly that
// (docs/git-safety.md, rows 65–67).
import type { BackupRequest, PushCommit, PushPlan, PushRequest, PushResult } from '../shared/protocol.ts'
import { assertName } from './actions.ts'
import { createBackup } from './backup.ts'
import { NETWORK_TIMEOUT_MS } from './branchActions.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'
import { operationRefusal } from './rebase.ts'
import { noteWarnings } from './warnings.ts'

const HASH = /^[0-9a-f]{40}$/
/** At most this many commits go to the dialog; the count covers all of them. */
const LISTED = 200

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The commit `ref` names, or null when there is none. */
async function tip(git: Git, ref: string): Promise<string | null> {
  const out = (await git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`])).stdout.trim()
  return HASH.test(out) ? out : null
}

/** The commits `revs` select, newest first: at most LISTED of them, and how many there are. */
async function commitsOf(git: Git, revs: string[]): Promise<{ list: PushCommit[]; count: number }> {
  const [out, count] = await Promise.all([
    git.out(['log', '--encoding=UTF-8', '-z', `-n${LISTED}`, '--format=%H %s', ...revs, '--']),
    git.out(['rev-list', '--count', ...revs, '--'])
  ])
  const list = out
    .split('\0')
    .filter(Boolean)
    .map((record) => ({ hash: record.slice(0, 40), subject: record.slice(41) }))
  return { list, count: Number(count.trim()) || list.length }
}

const remotesOf = async (git: Git) => (await git.out(['remote'])).split(/\r?\n/).filter(Boolean)

/** What pushing the current branch would send and where. Never throws. */
export async function checkPush(git: Git): Promise<{ ok: true; plan: PushPlan } | { ok: false; reason: string }> {
  try {
    const branch = (await git.run(['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim()
    if (!branch) throw new Error(t('pushDetached'))
    const busy = await operationRefusal(git)
    if (busy) throw new Error(busy)
    const remotes = await remotesOf(git)
    if (!remotes.length) throw new Error(t('noRemotes'))
    const hash = await tip(git, `refs/heads/${branch}`)
    if (!hash) throw new Error(t('pushNoCommitsYet'))
    // Where a plain `git push` would send the branch: push.default, remote.pushDefault and branch.<name>.pushRemote decide.
    // %(push:remoteref) is empty unless remote.<name>.push says, so the name comes from %(push), the push target's
    // remote-tracking branch, or else from the upstream on the same remote (push.default=simple with another name).
    const [target = '', targetRef = '', tracking = '', upstreamRemote = '', upstreamRef = ''] = (
      await git.out(['for-each-ref', '--format=%(push:remotename)%00%(push:remoteref)%00%(push)%00%(upstream:remotename)%00%(upstream:remoteref)%00', `refs/heads/${branch}`])
    ).split('\0')
    const heads = 'refs/heads/'
    const fromTracking = tracking.startsWith(`refs/remotes/${target}/`) ? tracking.slice(`refs/remotes/${target}/`.length) : ''
    const fromUpstream = upstreamRemote === target && upstreamRef.startsWith(heads) ? upstreamRef.slice(heads.length) : ''
    const known = remotes.includes(target) ? (targetRef.startsWith(heads) ? targetRef.slice(heads.length) : fromTracking || fromUpstream) : ''
    const publish = !known
    const preferred = (await git.run(['config', 'remote.pushDefault'])).stdout.trim()
    const remote = publish ? [preferred, 'origin', remotes[0]].find((name) => remotes.includes(name)) ?? remotes[0] : target
    const remoteBranch = publish ? branch : known
    const remoteTip = publish ? null : await tip(git, tracking || `refs/remotes/${remote}/${remoteBranch}`)
    // Against the remote branch as last fetched; with none, against everything fetched from that remote.
    const ahead = await commitsOf(git, [hash, '--not', remoteTip ?? `--remotes=${remote}`])
    const behind = remoteTip ? await commitsOf(git, [remoteTip, '--not', hash]) : { list: [], count: 0 }
    return {
      ok: true,
      plan: { branch, hash, remote, remoteBranch, publish, remotes, remoteTip, commits: ahead.list, count: ahead.count, remoteOnly: behind.list, remoteOnlyCount: behind.count }
    }
  } catch (error) {
    return { ok: false, reason: messageOf(error) }
  }
}

/** Pushes `request.branch` at the commit the dialog showed; a force push only with a lease on the remote tip it showed. Never throws. */
export async function runPush(plain: Git, request: unknown): Promise<PushResult> {
  const { git, withWarnings } = noteWarnings(plain)
  const { branch, hash, remote, remoteBranch, setUpstream, force, backup } = (request ?? {}) as Partial<PushRequest>
  let made: string | undefined
  try {
    const names = [branch, remote, remoteBranch].every((value) => typeof value === 'string')
    const expect = force?.expect
    const lease = force === undefined || (!setUpstream && (expect === null || (typeof expect === 'string' && HASH.test(expect))))
    if (!names || typeof hash !== 'string' || !HASH.test(hash) || typeof setUpstream !== 'boolean' || !lease) throw new Error(t('pushInvalid'))
    await assertName(git, branch!, 'branch')
    await assertName(git, remoteBranch!, 'branch')
    if (!(await remotesOf(git)).includes(remote!)) throw new Error(t('pushInvalid'))
    const busy = await operationRefusal(git)
    if (busy) throw new Error(busy)
    // The commits the dialog listed, never ones made since.
    if ((await tip(git, `refs/heads/${branch}`)) !== hash) throw new Error(t('repoChanged'))
    if (backup !== undefined) {
      if (!force?.expect || (backup as BackupRequest | null)?.target !== force.expect) throw new Error(t('backupInvalid'))
      const result = await createBackup(git, backup)
      if (!result.ok) return { ok: false, message: result.message, ...(result.name ? { backup: result.name } : {}) }
      made = result.name
    }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
  const pair = `refs/heads/${branch}:refs/heads/${remoteBranch}`
  const result = await git.run(
    [
      'push',
      '--porcelain',
      ...(setUpstream ? ['--set-upstream'] : []),
      // An empty expected value: only while the remote branch does not exist.
      ...(force ? [`--force-with-lease=refs/heads/${remoteBranch}:${force.expect ?? ''}`] : []),
      '--end-of-options',
      remote!,
      pair
    ],
    { timeoutMs: NETWORK_TIMEOUT_MS }
  )
  const target = `${remote}/${remoteBranch}`
  const kept = made ? { backup: made } : {}
  // --porcelain prints one line per ref: <flag> TAB <from>:<to> TAB <summary> (<reason>); `!` is a rejected ref.
  const line = result.stdout.split('\n').find((row) => row.split('\t')[1] === pair) ?? ''
  if (result.ok && line[0] !== '!') return withWarnings({ ok: true, message: t(line[0] === '=' ? 'pushUpToDate' : 'pushed', { target }), ...kept })
  const reason = /\(([^)]*)\)\s*$/.exec(line)?.[1] ?? ''
  const tail = lastLines(result.stderr, 4)
  const detail = tail ? `\n${tail}` : ''
  const behind = reason === 'non-fast-forward' || reason === 'fetch first'
  if (behind && setUpstream) return { ok: false, message: t('pushNameTaken', { target }) + detail, ...kept }
  if (reason === 'non-fast-forward' && !force) return { ok: false, diverged: true, message: t('pushDiverged', { target }) + detail, ...kept }
  if (reason === 'fetch first') return { ok: false, message: t('pushFetchFirst', { target }) + detail, ...kept }
  if (reason === 'stale info') return { ok: false, message: t('pushStale', { target }) + detail, ...kept }
  return { ok: false, message: t('pushFailed', { target }) + detail, ...kept }
}
