import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { pickLocale, setLocale, t } from '../shared/i18n.ts'
import type { ActionResult, DiffTabState, NoteImage, NoteResult, RepoResult, RevealResult, ReviewNote, SelectionFile } from '../shared/protocol.ts'
import { stateOf, unsentOf, waitingFor } from '../shared/notes.ts'
import { answerImages, attachImage, checkImages, dropImages, putImage, readImage, sweepImages } from './images.ts'
import { checkRewrite, runAction } from './actions.ts'
import { checkBackup, checkReset, deleteBackup, runGuarded } from './backup.ts'
import { checkRebaseOnto, fetchAll, runBranchAction } from './branchActions.ts'
import { DIFF_ANCHOR, fitWindow, workspaceFor } from './diffTab.ts'
import { buildFileTree, orderedFiles } from '../shared/filetree.ts'
import { createGit, type Git } from './git.ts'
import { readDetails, readLogPage, readRefs } from './log.ts'
import { resolveRepo, toplevel } from './repo.ts'
import { takeReveal } from './reveal.ts'
import { readFileDiff } from './diff.ts'
import { readRangeDiff, readSelectionFiles } from './selection.ts'
import { addNote, agentKey, deleteNotes, editMessage, fitList, listNotes, markSent, markUnsent, pendingRoots, removeMessage, replyNote, resendNote, resolveNote, setAnswers, setNotesLog } from './notes.ts'
import { promptRefusal, readAnswers, removeReview, reviewPaths, reviewPrompt, writeReview } from './review.ts'
import { browseSkills, checkSkills, listSkills, saveSkills, skillPathAbs, skillsForReview } from './skills.ts'
import { createPatch } from './patch.ts'
import { checkPush, runPush } from './push.ts'
import { gitTooOld } from './rebase.ts'
import { watchRepo, type RepoWatcher } from './watch.ts'

let orcaApi: OrcaWorkerApi
const repos = new Map<string, Git>()
const watchers = new Map<string, Promise<RepoWatcher | null>>()
/** The root each panel (by its id) watches: one that shows another repository lets the old watcher go. */
const watchedBy = new Map<string, string>()
/** What each repository's Diff tab shows; the tab reads it when it starts and on `diff.show`. */
const diffStates = new Map<string, DiffTabState>()
/** Roots with a request running that changes the repository. */
const changing = new Set<string>()
/** Roots with a `notes.send` running: a second one at once would start a second agent. */
const sending = new Set<string>()

/**
 * Runs `change` on `root` (as `gitFor` accepted it) unless another change to it is running: that one is refused, not
 * queued. The result is also posted as `action.done` with the request's `id`, for a panel that stopped waiting (Orca
 * gives up after 120 s).
 */
async function exclusive<T extends ActionResult>(root: string, id: unknown, change: () => Promise<T>): Promise<T | ActionResult> {
  if (changing.has(root)) return { ok: false, message: t('repoBusy') }
  changing.add(root)
  let result: T | ActionResult
  try {
    result = await change()
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    changing.delete(root)
  }
  orcaApi.panels.post('action.done', { root, id: typeof id === 'string' ? id : '', result })
  return result
}

async function setting<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await orcaApi.settings.get(key)
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const gitPath = () => setting('gitPath', 'git').then((path) => (typeof path === 'string' && path.trim()) || 'git')

/**
 * Actions on the current branch, and those that move HEAD elsewhere (a checkout, a new branch checked out): a frame
 * must send the HEAD their confirmation showed (`expectHead`).
 */
const ON_HEAD = new Set(['cherryPick', 'revert', 'reset', 'undo', 'squash', 'fixup', 'drop', 'reword', 'rebase', 'merge', 'rebaseOnto', 'checkout'])
const onHead = (action: any) => ON_HEAD.has(action?.kind) || (action?.kind === 'branch' && action?.checkout === true)

/** A git runner for a root a panel sends back; only roots this worker resolved are accepted. */
async function gitFor(root: unknown): Promise<Git> {
  if (typeof root !== 'string' || !root) throw new Error(t('missingRepo'))
  const known = repos.get(root)
  if (known) return known
  const path = await gitPath()
  if (resolve(root) !== root || (await toplevel(root, path)) !== root) throw new Error(t('notGitRepo', { name: root }))
  const git = createGit(root, path)
  repos.set(root, git)
  return git
}

/** Adds `pattern` to the repository's info/exclude so the anchor never shows as untracked. */
async function exclude(git: Git, root: string, pattern: string): Promise<void> {
  const file = resolve(root, (await git.out(['rev-parse', '--git-path', 'info/exclude'])).trim())
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).includes(pattern)) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`)
}

const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants

/** Whether `anchor` is the file this plugin wrote for `root`. Never follows a link or waits on a FIFO. */
function isOurAnchor(anchor: string, root: string): boolean {
  let fd: number
  try {
    fd = openSync(anchor, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return false
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) return false
    const bytes = new Uint8Array(stat.size)
    const read = readSync(fd, bytes, 0, bytes.length, 0)
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, read)))?.root === root
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Creates the Diff tab's anchor, or accepts the one this plugin already wrote for `root` as it is.
 * Otherwise returns why not; anything else under that name is left alone.
 */
function claimAnchor(anchor: string, root: string, text: string): string | null {
  let fd: number
  try {
    // wx never follows a symlink, even a dangling one, and never replaces a file.
    fd = openSync(anchor, 'wx')
  } catch (error: any) {
    if (error?.code === 'EEXIST') return isOurAnchor(anchor, root) ? null : t('diffAnchorTaken', { path: anchor })
    return t('diffAnchorFailed', { path: anchor, code: error?.code ?? String(error) })
  }
  let failure: any = null
  try {
    writeFileSync(fd, text)
  } catch (error) {
    failure = error
  } finally {
    closeSync(fd)
  }
  if (!failure) return null
  // Only the file this call created: a half-written one would be refused as not ours on every later click.
  try {
    unlinkSync(anchor)
  } catch {
    // Already gone.
  }
  return t('diffAnchorFailed', { path: anchor, code: failure?.code ?? String(failure) })
}

/** What `editor.open` needs to show the Diff tab of the workspace that holds `root`, or why it cannot. */
async function diffTab(root: string): Promise<{ workspaceId: string; path: string } | { reason: string }> {
  const git = await gitFor(root)
  const workspace = await workspaceFor(orcaApi, root, await gitPath())
  if (!workspace) return { reason: t('diffNoWorkspace') }
  const anchor = join(workspace.path, DIFF_ANCHOR)
  const refused = claimAnchor(anchor, root, `${JSON.stringify({ root, workspaceId: workspace.id }, null, 2)}\n`)
  if (refused) return { reason: refused }
  await exclude(git, root, DIFF_ANCHOR)
  return { workspaceId: workspace.id, path: DIFF_ANCHOR }
}

/**
 * Opens the Diff tab on the file `path` changed by commit `to` in the selection `hashes`. The worker lists the files itself:
 * a frame message is capped at 65 KiB, too little for a large selection's list.
 */
async function openDiff(input: any): Promise<{ ok: boolean; reason?: string }> {
  const { root, hashes, path, to, note } = input ?? {}
  if (typeof path !== 'string' || typeof to !== 'string') return { ok: false, reason: t('diffInvalid') }
  const files = orderedFiles(buildFileTree(await readSelectionFiles(await gitFor(root), hashes)))
  const index = files.findIndex((file) => file.path === path && file.to === to)
  if (index < 0) return { ok: false, reason: t('diffInvalid') }
  return showDiff(root, files, index, typeof note === 'string' && /^[0-9a-f]{12}$/.test(note) ? note : undefined)
}

/** Shows `files` in the Diff tab of `root` on the one at `index`; `reveal` is the note the tab scrolls to once. */
async function showDiff(root: string, files: SelectionFile[], index: number, reveal?: string): Promise<{ ok: boolean; reason?: string }> {
  const tab = await diffTab(root)
  if ('reason' in tab) return { ok: false, reason: tab.reason }
  // A response to a frame is capped at 1 MiB: the tab gets the files around this one that fit in 900 000 bytes of JSON.
  const { first, count } = fitWindow(files, index)
  const previous = diffStates.get(root)
  diffStates.set(root, { root, files: files.slice(first, first + count), index: index - first, ...(reveal ? { reveal } : {}) })
  try {
    await orcaApi.host.call('editor.open', tab)
  } catch (error) {
    // No tab opened: a later one must not show these files.
    if (previous) diffStates.set(root, previous)
    else diffStates.delete(root)
    throw error
  }
  // An open tab reads the new state on this event; a new one reads it when it starts.
  orcaApi.panels.post('diff.show', { root })
  return { ok: true }
}

/** Brings the Diff tab of `root` forward as it is: no new state, no `diff.show`, so it keeps its scroll. */
async function focusDiff({ root }: { root: string }): Promise<{ ok: boolean; reason?: string }> {
  if (!diffStates.has(root)) return { ok: false }
  const tab = await diffTab(root)
  if ('reason' in tab) return { ok: false, reason: tab.reason }
  await orcaApi.host.call('editor.open', tab)
  return { ok: true }
}

export default function activate(orca: OrcaWorkerApi): void {
  setNotesLog((line) => orca.log(line))
  orcaApi = orca
  // A panel drops what it waited for from a worker before this one: that is never posted.
  orca.panels.post('worker.started', {})

  // Each request names the caller's language; set it before the handler runs.
  const handle = (name: string, handler: (input: any, context: PanelRequestContext) => unknown) =>
    orca.panels.handle(name, (input: any, context) => {
      setLocale(pickLocale(input?.locale))
      return handler(input, context)
    })

  handle('repo.resolve', async (input): Promise<RepoResult> => {
    const result = await resolveRepo(orca, await gitPath(), input?.root, input?.workspaceId)
    if (!result.ok) return result
    if (result.git) repos.set(result.repo.root, result.git)
    return { ok: true, repo: result.repo }
  })

  // A commit another program asked the panel to show (src/worker/reveal.ts): its repository and its full hash, once.
  handle('reveal.take', async (): Promise<RevealResult | null> => {
    const asked = takeReveal()
    if (!asked) return null
    const result = await resolveRepo(orca, await gitPath(), asked.root)
    if (!result.ok || !result.git) return null
    repos.set(result.repo.root, result.git)
    const hash = await result.git.run(['rev-parse', '--verify', '--quiet', `${asked.hash}^{commit}`])
    return hash.ok ? { repo: result.repo, hash: hash.stdout.trim() } : null
  })

  handle('repo.refs', async ({ root }) => readRefs(await gitFor(root)))

  handle('repo.watch', async ({ root }, { panel }) => {
    const git = await gitFor(root)
    const previous = watchedBy.get(panel.id)
    watchedBy.set(panel.id, root)
    if (previous !== undefined && ![...watchedBy.values()].includes(previous)) {
      void watchers.get(previous)?.then((w) => w?.close())
      watchers.delete(previous)
    }
    if (!watchers.has(root)) {
      watchers.set(
        root,
        watchRepo(git, root, () => orca.panels.post('repo.changed', { root })).catch(() => null)
      )
    }
    return { ok: (await watchers.get(root)) !== null }
  })

  handle('log.page', async ({ root, filter, skip, limit }) => {
    const pageSize = Number(limit ?? (await setting('pageSize', 300)))
    const size = Math.min(2000, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 300))
    return readLogPage(await gitFor(root), filter ?? {}, Math.max(0, Math.floor(Number(skip) || 0)), size)
  })

  handle('commit.details', async ({ root, hash }) => readDetails(await gitFor(root), hash))

  handle('file.diff', async ({ root, hash, path, oldPath, wholeFile }) =>
    readFileDiff(await gitFor(root), hash, path, oldPath, Boolean(wholeFile))
  )

  // shortcut: the answer has no window, and the blobs add 106 bytes a file: a selection of more than ~3 800 files (50-character paths) passes Orca's 1 MiB; split Files into pages when that is needed.
  handle('selection.files', async ({ root, hashes }) => readSelectionFiles(await gitFor(root), hashes))

  handle('range.diff', async ({ root, from, to, path, oldPath, wholeFile }) =>
    readRangeDiff(await gitFor(root), from, to, path, oldPath, Boolean(wholeFile))
  )

  handle('patch.create', async ({ root, hashes, path, overwrite }) =>
    createPatch(await gitFor(root), root, hashes, path, overwrite === true)
  )

  handle('action.check', async ({ root, kind, hashes }) => checkRewrite(await gitFor(root), kind, hashes))

  // Every request that changes the repository, backups included, first checks that git is new enough for the guards.
  handle('action.run', async ({ root, action, expectHead, backup, id }) => {
    const git = await gitFor(root)
    return exclusive(root, id, async () => {
      const old = await gitTooOld(git)
      if (old) return { ok: false, message: old }
      const hardReset = action?.kind === 'reset' && action?.mode === 'hard'
      const result = await runGuarded(git, { expectHead, backup }, 'HEAD', () => runAction(git, action), { hardReset, onHead: onHead(action) })
      orca.panels.post('repo.changed', { root })
      return result
    })
  })

  handle('branch.run', async ({ root, action, expectHead, backup, id }) => {
    const git = await gitFor(root)
    return exclusive(root, id, async () => {
      const old = await gitTooOld(git)
      if (old) return { ok: false, message: old }
      // A deleted branch's backup keeps that branch; every other branch action moves HEAD.
      const tip = action?.kind === 'delete' ? { branch: action.name } : 'HEAD'
      const result = await runGuarded(git, { expectHead, backup }, tip, () => runBranchAction(git, action), { onHead: onHead(action) })
      orca.panels.post('repo.changed', { root })
      return result
    })
  })

  handle('backup.check', async ({ root, kind, name }) => checkBackup(await gitFor(root), kind, name))

  handle('reset.check', async ({ root, target }) => checkReset(await gitFor(root), root, target))

  handle('backup.delete', async ({ root, action, id }) => {
    const git = await gitFor(root)
    return exclusive(root, id, async () => {
      const old = await gitTooOld(git)
      if (old) return { ok: false, message: old }
      const result = await deleteBackup(git, action)
      orca.panels.post('repo.changed', { root })
      return result
    })
  })

  handle('branch.check', async ({ root, name }) => checkRebaseOnto(await gitFor(root), name))

  handle('repo.fetch', async ({ root, id }) => {
    const git = await gitFor(root)
    return exclusive(root, id, async () => {
      const old = await gitTooOld(git)
      if (old) return { ok: false, message: old }
      const result = await fetchAll(git)
      if (result.ok) orca.panels.post('repo.changed', { root })
      return result
    })
  })

  handle('push.check', async ({ root }) => checkPush(await gitFor(root)))

  handle('push.run', async ({ root, push, id }) => {
    const git = await gitFor(root)
    return exclusive(root, id, async () => {
      const old = await gitTooOld(git)
      if (old) return { ok: false, message: old }
      const result = await runPush(git, push)
      // A push moves the remote-tracking branch and may set the upstream; a backup may have been made even when it failed.
      orca.panels.post('repo.changed', { root })
      return result
    })
  })

  handle('diff.open', openDiff)

  handle('diff.focus', focusDiff)

  // The tab reveals a note once: a later `diff.show` or a reload of its frame reads the state without it.
  handle('diff.state', ({ root }) => {
    const state = diffStates.get(root)
    if (state?.reveal) diffStates.set(root, { root, files: state.files, index: state.index })
    return state ?? null
  })

  handle('diff.index', ({ root, index }) => {
    const state = diffStates.get(root)
    if (!state || !Number.isInteger(index) || index < 0 || index >= state.files.length) return { ok: false }
    diffStates.set(root, { root, files: state.files, index })
    orca.panels.post('diff.current', { root, path: state.files[index].path })
    return { ok: true }
  })

  /** Removes the files of `images` that no message of a note of `root` uses any more, and the unused files older than a day. Best effort: never throws. */
  const dropFiles = async (root: string, images: (NoteImage[] | undefined)[]): Promise<void> => {
    try {
      const notes = await listNotes(orca.storage, root)
      dropImages(root, images.flatMap((list) => (list ?? []).map((i) => i.id)), notes)
      sweepImages(root, notes, Date.now())
    } catch (error) {
      orca.log(`images not removed for ${root}: ${errorText(error)}`)
    }
  }

  /** Some answers were read and could not be stored: the others are stored. */
  class AnswersRefused extends Error {}

  /** Stores the answers the agent has written for `root` and tells the panels. Throws when they cannot be read, or an `AnswersRefused` when some cannot be stored. */
  const ingest = async (root: string): Promise<void> => {
    const before = await listNotes(orca.storage, root)
    const found = readAnswers(root, before)
    if (!found.size) return
    // The pictures an answer shows go in as files of their own; the same ones again give the same ids.
    for (const [id, answer] of found) {
      const images = answerImages(root, reviewPaths(root, answer.review).answers, answer.body)
      if (images.length) found.set(id, { ...answer, images })
    }
    const { changed, refused } = await setAnswers(orca.storage, root, found)
    // The pictures of an answer that was replaced or not kept go when no message uses them.
    await dropFiles(root, [...found.values(), ...before.filter((n) => found.has(n.id)).flatMap((n) => n.messages.filter((m) => m.author === 'agent'))].map((m) => m.images))
    if (changed) orca.panels.post('notes.changed', { root })
    // The ones stored stay stored; the caller tells the user about the rest.
    if (refused.length) throw new AnswersRefused(`${refused.length} of ${found.size}: ${refused[0].error}`)
  }

  orca.events.on('agent.status.changed', async () => {
    try {
      for (const root of await pendingRoots(orca.storage)) {
        try {
          // Frames share the storage: only the top level of a repository is read in, and one that is not is skipped.
          await ingest((await gitFor(root)).root)
        } catch (error) {
          orca.log(`${error instanceof AnswersRefused ? 'answers not stored' : 'answers not read'} for ${root}: ${errorText(error)}`)
        }
      }
    } catch (error) {
      orca.log(`answers not read: ${errorText(error)}`)
    }
  })

  handle('notes.list', async ({ root }) => {
    const key = (await gitFor(root)).root
    let warning = ''
    try {
      await ingest(key)
    } catch (error) {
      orca.log(`${error instanceof AnswersRefused ? 'answers not stored' : 'answers not read'}: ${errorText(error)}`)
      // Most likely the stored value would pass Orca's 262144 bytes: the user has to know, and can free space.
      warning = t('notesAnswersFailed', { error: errorText(error) })
    }
    const { notes, cut } = fitList(await listNotes(orca.storage, key))
    if (cut) warning = [warning, t('notesCut', { count: cut })].filter(Boolean).join(' ')
    return warning ? { notes, warning } : { notes }
  })

  /** Tells the panels when a change of the notes of `root` went through. */
  const told = (root: string, result: NoteResult): NoteResult => {
    if (result.ok) orca.panels.post('notes.changed', { root })
    return result
  }

  /** The images of a new message, checked against the files; or why not. */
  const withImages = async (git: Git, images: unknown): Promise<{ ok: true; images: NoteImage[] } | { ok: false; reason: string }> => {
    const checked = checkImages(git.root, images)
    if (checked.ok && checked.images.length) await exclude(git, git.root, '.orca-git-log/')
    return checked
  }

  handle('notes.add', async ({ root, draft }) => {
    const git = await gitFor(root)
    const key = git.root
    const checked = await withImages(git, draft?.images)
    if (!checked.ok) return checked
    return told(key, await addNote(orca.storage, key, { ...draft, images: checked.images }))
  })

  handle('notes.reply', async ({ root, id, body, images }) => {
    const git = await gitFor(root)
    const key = git.root
    const checked = await withImages(git, images)
    if (!checked.ok) return checked
    return told(key, await replyNote(orca.storage, key, id, body, checked.images))
  })

  handle('notes.edit', async ({ root, id, message, body }) => {
    const key = (await gitFor(root)).root
    return told(key, await editMessage(orca.storage, key, id, message, body))
  })

  handle('notes.resolve', async ({ root, id, resolved }) => {
    const key = (await gitFor(root)).root
    return told(key, await resolveNote(orca.storage, key, id, resolved))
  })

  /** Removes the folders of `reviews` that no message of a note of `root` references any more. */
  const dropReviews = async (root: string, reviews: (string | undefined)[]): Promise<void> => {
    const left = new Set((await listNotes(orca.storage, root)).flatMap((n) => n.messages.map((m) => m.review)))
    for (const review of new Set(reviews)) if (review && !left.has(review)) removeReview(root, review)
  }

  handle('notes.resend', async ({ root, id }) => {
    const key = (await gitFor(root)).root
    const note = (await listNotes(orca.storage, key)).find((n) => n.id === id)
    const before = note && waitingFor(note)
    const result = await resendNote(orca.storage, key, id)
    // The messages left their send: the folder goes with the last message of it.
    if (result.ok) await dropReviews(key, [before])
    return told(key, result)
  })

  handle('notes.remove', async ({ root, id, message }) => {
    const key = (await gitFor(root)).root
    const gone = (await listNotes(orca.storage, key)).find((n) => n.id === id)?.messages.find((m) => m.id === message)
    const result = await removeMessage(orca.storage, key, id, message)
    if (result.ok) {
      await dropReviews(key, [gone?.review])
      await dropFiles(key, [gone?.images])
    }
    return told(key, result)
  })

  handle('notes.delete', async ({ root, ids, all }) => {
    const key = (await gitFor(root)).root
    let gone: ReviewNote[]
    try {
      // All: the threads a cut list did not show go too.
      gone = await deleteNotes(orca.storage, key, all === true ? 'all' : ids)
    } catch (error) {
      return { ok: false, reason: t('notesSaveFailed', { error: errorText(error) }) }
    }
    if (gone.length) {
      await dropReviews(key, gone.flatMap((n) => n.messages.map((m) => m.review)))
      await dropFiles(key, gone.flatMap((n) => n.messages.map((m) => m.images)))
      orca.panels.post('notes.changed', { root: key })
    }
    return { ok: true }
  })

  const KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/i

  /** The record of the agent the last send of `key` went to; null when it is missing or does not fit the repository (frames share the storage). */
  const agentRecord = async (key: string): Promise<{ terminalId: string; agent: string } | null> => {
    try {
      const stored = (await orca.storage.get(agentKey(key))) as { root?: unknown; terminalId?: unknown; agent?: unknown } | null
      if (stored?.root !== key || typeof stored.terminalId !== 'string' || !stored.terminalId || typeof stored.agent !== 'string' || !KIND.test(stored.agent)) return null
      return { terminalId: stored.terminalId, agent: stored.agent }
    } catch {
      return null
    }
  }

  /** Whether the agent of `record` is free: `agents.list` (the focused workspace) holds its terminal with the same kind in state `done`. Orca not saying is not free. */
  const isFree = async (record: { terminalId: string; agent: string }): Promise<boolean> => {
    try {
      const { agents } = (await orca.host.call('agents.list')) as { agents?: { terminalId: string | null; agent: string | null; state: string }[] }
      const found = Array.isArray(agents) ? agents.find((a) => a?.terminalId === record.terminalId) : undefined
      return found?.agent === record.agent && found.state === 'done'
    } catch {
      return false
    }
  }

  /** Whether the prompt of `key` may be typed into a terminal: the review id (12 hex) and the skills add no character the check refuses, so any id stands in. */
  const typable = (key: string): boolean => promptRefusal(reviewPrompt(reviewPaths(key, '000000000000')), true) === null

  handle('notes.agent', async ({ root }) => {
    const key = (await gitFor(root)).root
    const record = typable(key) ? await agentRecord(key) : null
    return { agent: record && (await isFree(record)) ? record.agent : null }
  })

  /** Writes the review folder, marks the notes sent, then starts a new agent of the kind `agent` names, or, without one, types the prompt into the earlier agent's terminal when it is free; a failed delivery takes the mark off again. */
  const sendNotes = async (git: Git, key: string, ids: unknown, agent: unknown): Promise<{ ok: true; review: string; to: 'same' | 'new' } | { ok: false; reason: string }> => {
    // Not resolved, not waiting for an answer (one send at a time per thread), with text not sent.
    const unsentNotes = async () => (await listNotes(orca.storage, key)).filter((n) => Array.isArray(ids) && ids.includes(n.id) && stateOf(n) === 'unsent')
    if (!(await unsentNotes()).length) return { ok: false, reason: t('reviewNothing') }
    // A named kind always starts a new agent; none (absent or null) means the earlier one, whose terminal takes only a prompt that can be typed.
    const named = agent !== undefined && agent !== null
    const same = named || !typable(key) ? null : await agentRecord(key)
    if (!named && !same) return { ok: false, reason: t('reviewPickAgent') }
    if (named && (typeof agent !== 'string' || !KIND.test(agent))) return { ok: false, reason: t('reviewBadAgent', { agent: String(agent).slice(0, 64) }) }
    const workspace = same ? null : await workspaceFor(orca, key, await gitPath())
    if (!same && !workspace) return { ok: false, reason: t('reviewNoWorkspace') }
    await exclude(git, key, '.orca-git-log/')
    let skills: string[] = []
    try {
      skills = await skillsForReview(orca.storage, key)
    } catch (error) {
      // The notes still go, without the skills.
      orca.log(`review skills not read for ${key}: ${errorText(error)}`)
    }
    // The threads and their NEW messages as they are now, after the waits above: what the notes file says is what gets marked.
    const notes = await unsentNotes()
    if (!notes.length) return { ok: false, reason: t('reviewNothing') }
    const review = randomBytes(6).toString('hex')
    const made = writeReview(key, review, notes, skills)
    if (!made.ok) return { ok: false, reason: made.reason }
    const prompt = reviewPrompt(made.paths, skills.length > 0)
    const refusal = promptRefusal(prompt, same !== null)
    if (refusal) {
      removeReview(key, review)
      return { ok: false, reason: refusal }
    }
    // The messages the notes file marks NEW: one written since stays unsent.
    const sent = new Map(notes.map((n) => [n.id, unsentOf(n).map((m) => m.id)]))
    // Marked before the launch: a mark that failed after it would leave a running agent and unsent notes, which a second send would give to another agent.
    try {
      await markSent(orca.storage, key, sent, review, Date.now(), same?.agent ?? String(agent))
    } catch (error) {
      removeReview(key, review)
      return { ok: false, reason: t('notesSaveFailed', { error: errorText(error) }) }
    }
    let terminalId = ''
    let notFree = false
    try {
      if (same) {
        // Checked as late as possible: the agent may have been given work since the menu opened.
        if (!(await isFree(same))) {
          notFree = true
          throw new Error('not free')
        }
        const { accepted } = (await orca.host.call('terminal.sendText', { terminalId: same.terminalId, text: prompt, enter: true })) as { accepted: boolean }
        if (!accepted) throw new Error('not accepted')
      } else {
        const launched = (await orca.host.call('agent.launch', { workspaceId: workspace!.id, agent: agent as string, prompt })) as { terminalId?: unknown }
        if (typeof launched?.terminalId === 'string') terminalId = launched.terminalId
      }
    } catch (error) {
      // When the mark cannot be taken off either, the notes stay sent: Send again gives them to a new agent.
      await markUnsent(orca.storage, key, review).catch((cause) => orca.log(`notes left marked sent: ${errorText(cause)}`))
      removeReview(key, review)
      // A terminal that did not take the text is not the one to try again.
      if (same && !notFree) await orca.storage.delete(agentKey(key)).catch((cause) => orca.log(`earlier agent not forgotten: ${errorText(cause)}`))
      orca.panels.post('notes.changed', { root: key })
      return { ok: false, reason: notFree ? t('reviewPickAgent') : same ? t('reviewSameFailed') : t('reviewLaunchFailed', { error: errorText(error) }) }
    }
    if (!same) {
      // The agent runs already. Without its terminal on record the next send asks which agent to use, and an older record must not stay: the next send would go to an older agent.
      try {
        if (!terminalId) throw new Error('Orca gave no terminal')
        await orca.storage.set(agentKey(key), { root: key, terminalId, agent: agent as string })
      } catch (error) {
        orca.log(`agent not recorded for ${key}: ${errorText(error)}`)
        await orca.storage.delete(agentKey(key)).catch((cause) => orca.log(`earlier agent not forgotten: ${errorText(cause)}`))
      }
    }
    orca.panels.post('notes.changed', { root: key })
    return { ok: true, review, to: same ? 'same' : 'new' }
  }

  handle('notes.send', async ({ root, ids, agent }) => {
    const git = await gitFor(root)
    const key = git.root
    if (sending.has(key)) return { ok: false, reason: t('reviewBusy') }
    sending.add(key)
    try {
      return await sendNotes(git, key, ids, agent)
    } finally {
      sending.delete(key)
    }
  })

  handle('skills.list', async ({ root }) => ({ skills: await listSkills(orca.storage, (await gitFor(root)).root) }))

  handle('skills.set', async ({ root, skills }) => {
    const key = (await gitFor(root)).root
    // A stored skill gone from the disk must not block the other changes.
    const checked = checkSkills(skills, key, await listSkills(orca.storage, key))
    if (checked.ok) await saveSkills(orca.storage, key, checked.skills)
    return checked
  })

  handle('skills.browse', async ({ root, dir }) => browseSkills(typeof dir === 'string' ? dir : '', (await gitFor(root)).root))

  handle('images.put', async ({ root, upload, index, last, data, name }) => {
    const git = await gitFor(root)
    // Before the file exists, so it never shows in git status.
    if (last === true) await exclude(git, git.root, '.orca-git-log/')
    return putImage(git.root, { upload, index, last, data, name })
  })

  handle('images.attach', async ({ root, path }) => {
    const git = await gitFor(root)
    if (typeof path !== 'string' || !path.trim() || /[\x00-\x1f\x7f]/.test(path)) return { ok: false, reason: t('imageMissing', { path: String(path).slice(0, 200) }) }
    await exclude(git, git.root, '.orca-git-log/')
    return attachImage(git.root, skillPathAbs(path.trim(), git.root))
  })

  handle('images.browse', async ({ root, dir }) => browseSkills(typeof dir === 'string' ? dir : '', (await gitFor(root)).root, (name) => /\.(png|jpe?g|gif|webp)$/i.test(name)))

  handle('images.get', async ({ root, id, offset }) => {
    const part = readImage((await gitFor(root)).root, id, offset, 600000)
    return part ? { data: Buffer.from(part.data).toString('base64'), total: part.total } : { data: '', total: 0 }
  })
}

export function deactivate(): void {
  setNotesLog(() => undefined)
  for (const watcher of watchers.values()) void watcher.then((w) => w?.close())
  watchers.clear()
  watchedBy.clear()
}
