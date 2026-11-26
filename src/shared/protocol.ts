// The sidebar/Diff tab <-> worker contract. Both sides import these types; nothing here runs.
import type { WireDiff } from './diffwire.ts'

export interface RepoInfo {
  root: string
  name: string
  workspaceId: string | null
  head: { branch: string | null; hash: string | null }
  /** A sequencer operation left in progress (by a terminal, say); rewrites are refused while set. */
  operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | null
  /** The cherry-pick or revert left only its todo list (.git/sequencer): `--quit` is the way out. */
  todoOnly: boolean
  /** The rebase never started and left only git's autostash (git before 2.47): `--quit`, then `stash pop --index`, is the way back. */
  autostashOnly: boolean
}

/** A local workspace the focused context could be, when several share its name and branch. */
export interface WorkspaceChoice {
  id: string
  name: string
  path: string
  branch: string
}

export type RepoResult = { ok: true; repo: RepoInfo } | { ok: false; reason: string; choices?: WorkspaceChoice[] }
/** A commit another program asked the panel to show: its repository and the full hash. */
export interface RevealResult { repo: RepoInfo; hash: string }

export interface BranchRef {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string
  /** Full ref name: `refs/heads/main`. */
  full: string
  hash: string
  upstream?: string
  /** Commits of a local branch its upstream lacks, and the other way round, as of the last fetch; absent when 0. */
  ahead?: number
  behind?: number
}

export interface RefsResult {
  head: { branch: string | null; hash: string | null }
  locals: BranchRef[]
  remotes: BranchRef[]
  tags: BranchRef[]
  users: string[]
  me: string | null
}

export interface CommitRow {
  hash: string
  parents: string[]
  author: string
  email: string
  authorTime: number
  committer: string
  commitTime: number
  subject: string
  /** Full ref names decorating this commit; `HEAD` when HEAD is detached here. */
  refs: string[]
}

export interface LogFilter {
  text?: string
  regex?: boolean
  matchCase?: boolean
  /** Revisions to show; empty means every branch, remote branch and tag. */
  branches?: string[]
  users?: string[]
  /** Unix seconds. */
  since?: number
  until?: number
  paths?: string[]
}

export interface LogPage {
  commits: CommitRow[]
  hasMore: boolean
}

export interface FileChange {
  status: string
  path: string
  oldPath?: string
}

/** A file changed by a commit selection, between two revisions (`from` null: the empty tree). */
export interface SelectionFile extends FileChange {
  from: string | null
  to: string
  /** Full blob ids of the two sides; absent for a side that does not exist. A pure rename or a mode change has two equal ids. */
  oldBlob?: string
  newBlob?: string
}

export interface CommitDetails {
  hash: string
  parents: string[]
  author: string
  email: string
  authorTime: number
  committer: string
  committerEmail: string
  commitTime: number
  message: string
  branches: string[]
}

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep'

export interface DiffLine {
  kind: ' ' | '+' | '-'
  text: string
  /** Line number in the old file (context and deletions). */
  old?: number
  /** Line number in the new file (context and additions). */
  new?: number
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  /** Function or section name git printed after the hunk range. */
  section: string
  lines: DiffLine[]
}

/** One file's changes in a commit, against its first parent. */
export interface FileDiff {
  path: string
  oldPath?: string
  binary: boolean
  /** The diff was cut short because it is too large. */
  truncated: boolean
  hunks: DiffHunk[]
  /** Full blob ids of the two sides; absent for a side that does not exist (a new or deleted file) or when the file is only renamed. */
  oldBlob?: string
  newBlob?: string
}

export type NoteSide = 'old' | 'new'
export interface NotePoint { line: number; col: number }
// answered: the note was a question, and the agent answered it
export type NoteVerdict = 'answered' | 'confirmed' | 'refuted' | 'unclear'
/** An answer file as read: what the agent's message for that send says. */
export interface NoteReply { verdict: NoteVerdict; fixed: boolean; body: string; at: number }
export type NoteAuthor = 'user' | 'agent'
/** id: the image's file name in .orca-git-log/images (12 hex of its sha256 and its extension); name: as the user sees it. */
export interface NoteImage { id: string; name: string; bytes: number }
export interface NoteMessage {
  id: string; author: NoteAuthor; body: string; at: number; images?: NoteImage[]
  /** A user's message: the send it went out with. An agent's message: the send it answers. */
  review?: string
  sentAt?: number
  verdict?: NoteVerdict; fixed?: boolean; agent?: string
}
/** Where a review note is: the blob of one side of one file. */
export interface NoteAnchor { path: string; side: NoteSide; blob: string; rev: string; start: NotePoint; end: NotePoint; quote: string }
/** A review note as the Diff tab sends it: its anchor and the user's first message. */
export interface NoteDraft extends NoteAnchor { body: string; images?: NoteImage[] }
/** A review note is a thread: the messages of the user and the agent, oldest first. */
export interface ReviewNote extends NoteAnchor {
  id: string
  createdAt: number
  messages: NoteMessage[]
  resolvedAt?: number
  /** Its lines changed since its commit, as of HEAD: computed by notes.list and a send, never stored. */
  outdated?: true
}
/** Where a note written on another version of a file stands on this one: its lines there, or `outdated` when they changed. */
export type NotePlace = { id: string; start: NotePoint; end: NotePoint } | { id: string; outdated: true }
/** null: the note is gone. */
export type NoteResult = { ok: true; note: ReviewNote | null } | { ok: false; reason: string }

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface PlanItem {
  hash: string
  action: RebaseAction
  /** pick: the final message of its group; reword/squash: this commit's new message. */
  message?: string
}

export type RewriteKind = 'squash' | 'fixup' | 'drop' | 'reword' | 'rebase' | 'undo'

export type ActionRequest =
  /**
   * `target`: a local branch, or with `detach: true` a full commit hash (a branch can be named like one).
   * `track`: a remote branch (full ref) to make `target` from, as a new local branch tracking it.
   * `leave`: move HEAD even though commits only a detached HEAD holds are left behind (asked first; see `leaves`).
   * `stash` / `carry`: what to do with what the checkout would touch (asked first; see `atRisk`): put it in a new
   * stash first, or take the changes along as git does (refused when something would be lost).
   */
  | { kind: 'checkout'; target: string; track?: string; detach?: boolean; leave?: boolean; stash?: boolean; carry?: boolean }
  | { kind: 'branch'; hash: string; name: string; checkout: boolean; leave?: boolean; stash?: boolean; carry?: boolean }
  | { kind: 'tag'; hash: string; name: string }
  | { kind: 'cherryPick'; hashes: string[] }
  | { kind: 'revert'; hashes: string[] }
  | { kind: 'reset'; hash: string; mode: ResetMode }
  | { kind: 'undo'; hash: string }
  | { kind: 'squash'; hashes: string[]; message: string }
  | { kind: 'fixup'; hashes: string[] }
  | { kind: 'drop'; hashes: string[] }
  | { kind: 'reword'; hash: string; message: string }
  | { kind: 'rebase'; plan: PlanItem[] }

export interface RangeCommit {
  hash: string
  subject: string
  message: string
}

export type CheckResult =
  | { ok: true; pushed: string[]; commits: RangeCommit[] }
  | { ok: false; reason: string }

/**
 * What moving HEAD to another commit would touch. `changed`: tracked files with changes in the index or the files;
 * `conflicts`: those of them the target changes too (git refuses); `untracked` / `ignored`: files where the target
 * writes a file (git refuses an untracked one and silently deletes an ignored one). `carry`: git can take the changes
 * along without losing any. Each list holds at most 50 paths in a reply; `more` counts the rest.
 */
export interface CheckoutRisk {
  changed: string[]
  conflicts: string[]
  untracked: string[]
  ignored: string[]
  carry: boolean
  more: number
}

export interface ActionResult {
  ok: boolean
  message: string
  /** HEAD before the action, so the UI can offer Undo. */
  previousHead?: string
  /** The backup branch or tag made before the action, even when the action then failed. */
  backup?: string
  /** The stash commit holding the uncommitted changes saved with the backup, or before a checkout. */
  stash?: string
  /** Nothing ran: the checkout would touch these; send it again with `stash` or `carry`. */
  atRisk?: CheckoutRisk
  /** HEAD after an action sent with `expectHead` or a backup ran, for its Undo to expect. */
  head?: string
  /** It ran, but left something for the user to sort out (the message says what); Undo only with `previousHead`. */
  warning?: boolean
  /** Nothing ran: moving HEAD would leave these commits (the first 20; `message` gives how many) on no branch. */
  leaves?: string[]
  /** The `warning:` messages git printed while the action ran and succeeded. */
  gitWarnings?: string[]
}

/** A branch or tag the worker creates at `target` (40 hex) before a risky action; never overwrites a ref. */
export interface BackupRequest {
  kind: 'branch' | 'tag'
  name: string
  target: string
  /** Also snapshot the uncommitted changes into the stash (reset --hard). */
  stash?: boolean
}

/** Deletes a `backup/` branch or tag, only while it still points at `hash`. */
export interface BackupDelete {
  kind: 'deleteBackup'
  ref: 'branch' | 'tag'
  name: string
  hash: string
}

/** What a hard reset would lose. */
export interface ResetCheck {
  /** Tracked files have uncommitted changes. */
  dirty: boolean
  /** Untracked files, ignored ones included, that the target tracks: the reset overwrites them. */
  overwritten: string[]
  /** Repositories, as `name/`, inside a folder the target replaces with a file: the reset deletes them whole. */
  repositories: string[]
  /** Folders the reset deletes that were too large or unreadable to search for repositories completely. */
  unchecked?: string[]
  /** With submodule.recurse set: populated submodules, as `name/`, the reset also resets or removes; nothing in them is checked. */
  submodules?: string[]
  /** Files git assumes unchanged that were edited, or could not be hashed: the reset writes them back. */
  assumeUnchanged?: string[]
  /** The index or the target's tree could not be read (too large), so neither of those two lists was checked. */
  indexUnchecked?: boolean
}

/**
 * Sent with `action.run` and `branch.run`: the HEAD the confirmation showed (null: no commit yet), and the backup to
 * make first. An action on the current branch without `expectHead` is refused.
 */
export interface ActionGuard {
  expectHead?: string | null
  backup?: BackupRequest
}

export type BranchAction =
  | { kind: 'rename'; name: string; newName: string }
  /** `tip`: the commit the dialog showed the branch at; `force` deletes only while the branch is still there. */
  | { kind: 'delete'; name: string; force: boolean; tip?: string }
  /**
   * `name`: the full ref, refs/heads/… or refs/remotes/… (a short name can mean another ref); `tip`: the commit the
   * menu showed it at, which it must still name.
   */
  | { kind: 'merge'; name: string; tip: string }
  | { kind: 'rebaseOnto'; name: string; tip: string }

export interface BranchActionResult extends ActionResult {
  /** The branch is not fully merged; deleting it needs force. */
  needsForce?: boolean
}

/** A commit a push dialog lists. */
export interface PushCommit {
  hash: string
  subject: string
}

/** What pushing the current branch would send, and where: `push.check`. */
export interface PushPlan {
  branch: string
  /** The commit the branch is at: the push sends exactly this and refuses once the branch moved. */
  hash: string
  /** Where a plain `git push` would go (push.default, remote.pushDefault, branch.<name>.pushRemote), or a default to publish to. */
  remote: string
  remoteBranch: string
  /** The branch has no push target yet: the dialog lets the user pick the remote and name, and the push sets the upstream. */
  publish: boolean
  remotes: string[]
  /** The remote branch as of the last fetch (`refs/remotes/<remote>/<branch>`), when there is one. */
  remoteTip: string | null
  /** Commits the remote lacks, newest first, at most 200; `count` is all of them. */
  commits: PushCommit[]
  count: number
  /** Commits the remote branch has and the local branch lacks: what a force push would drop. */
  remoteOnly: PushCommit[]
  remoteOnlyCount: number
}

export interface PushRequest {
  branch: string
  hash: string
  remote: string
  remoteBranch: string
  setUpstream: boolean
  /** Force with lease: overwrite the remote branch only while it is still at `expect` (null: only while it does not exist). */
  force?: { expect: string | null }
  /** Force only: a backup of the remote tip `force.expect`, made before the push. */
  backup?: BackupRequest
}

export interface PushResult extends ActionResult {
  /** The remote has commits the local branch lacks (non-fast-forward): a force push with lease is the way past it. */
  diverged?: boolean
}

export type PatchResult =
  | { ok: true; name: string; size: number; text?: string; tooLarge?: boolean; notUtf8?: boolean; path?: string }
  | { ok: false; reason: string; exists?: boolean }

/** What the Diff tab of a repository shows: the files of the selection a file was opened from. */
export interface DiffTabState {
  root: string
  files: SelectionFile[]
  index: number
  /** This opening of the tab: 12 hex, new on each `diff.open` and `notes.open`. The tab scrolls to `reveal` once per `open`. */
  open: string
  /** The id of the note the tab scrolls to once it shows the file; every `diff.state` gives it until `diff.index` or another opening. */
  reveal?: string
}

declare module 'orca' {
  interface PluginRequests {
    'repo.resolve': { input: { root?: string; workspaceId?: string }; output: RepoResult }
    'reveal.take': { input: Record<string, never>; output: RevealResult | null }
    'repo.refs': { input: { root: string }; output: RefsResult }
    'repo.watch': { input: { root: string }; output: { ok: boolean } }
    'log.page': { input: { root: string; filter: LogFilter; skip: number; limit?: number }; output: LogPage }
    'log.selectionDepth': { input: { root: string; filter: LogFilter; skip: number; hashes: string[] }; output: number }
    'commit.details': { input: { root: string; hash: string }; output: CommitDetails }
    'file.diff': { input: { root: string; hash: string; path: string; oldPath?: string; wholeFile?: boolean }; output: WireDiff }
    'selection.files': { input: { root: string; hashes: string[] }; output: SelectionFile[] }
    'range.diff': { input: { root: string; from: string | null; to: string; path: string; oldPath?: string; wholeFile?: boolean }; output: WireDiff }
    'patch.create': { input: { root: string; hashes: string[]; path?: string; overwrite?: boolean }; output: PatchResult }
    'action.check': { input: { root: string; kind: RewriteKind; hashes: string[] }; output: CheckResult }
    /** `id`: echoed in `action.done`, so a panel that stopped waiting knows its result. */
    'action.run': { input: { root: string; action: ActionRequest; id?: string } & ActionGuard; output: ActionResult }
    'branch.run': { input: { root: string; action: BranchAction; id?: string } & ActionGuard; output: BranchActionResult }
    'backup.delete': { input: { root: string; action: BackupDelete; id?: string }; output: ActionResult }
    /** Whether `name` can become a new backup branch or tag; read-only. */
    'backup.check': { input: { root: string; kind: 'branch' | 'tag'; name: string }; output: { ok: true } | { ok: false; reason: string } }
    /** What a hard reset to `target` would lose: uncommitted tracked changes, untracked files it overwrites; read-only. */
    'reset.check': { input: { root: string; target: string }; output: ResetCheck }
    /** Remote branches holding commits that rebasing the current branch onto `name` would rewrite. */
    /** `name`: the full ref, as for `rebaseOnto`. */
    'branch.check': { input: { root: string; name: string }; output: { pushed: string[] } }
    'repo.fetch': { input: { root: string; id?: string }; output: ActionResult }
    'push.check': { input: { root: string }; output: { ok: true; plan: PushPlan } | { ok: false; reason: string } }
    'push.run': { input: { root: string; push: PushRequest; id?: string }; output: PushResult }
    /** Opens the Diff tab on the file `path` changed by commit `to` in the selection `hashes`; the worker lists the files. `note`: the id of a note the tab scrolls to once; anything but 12 hex is ignored. */
    'diff.open': { input: { root: string; hashes: string[]; path: string; to: string; note?: string }; output: { ok: boolean; reason?: string } }
    /** Brings forward the Diff tab `diff.open` showed for `root`, without reloading it; `ok: false` if none was shown. */
    'diff.focus': { input: { root: string }; output: { ok: boolean; reason?: string } }
    'diff.state': { input: { root: string }; output: DiffTabState | null }
    /** The Diff tab stepped to another file of its state. */
    'diff.index': { input: { root: string; index: number }; output: { ok: boolean } }
    'notes.list': { input: { root: string }; output: { notes: ReviewNote[]; warning?: string } }
    /** Opens the Diff tab on the commit whose own diff shows the note `id`, to scroll to it once, and posts `commit.reveal`; `reason` when the note, its commit or its file there is gone. */
    'notes.open': { input: { root: string; id: string }; output: { ok: boolean; reason?: string } }
    /** Per file of `files`, in their order: the notes of other versions of its sides carried to it, and the outdated ones; [] for a file with none. At most 100 files, else refused. */
    'notes.place': { input: { root: string; files: SelectionFile[] }; output: { places: NotePlace[][] } }
    'notes.add': { input: { root: string; draft: NoteDraft }; output: NoteResult }
    /** A new message of the user at the end of the thread; it opens a resolved one again. */
    'notes.reply': { input: { root: string; id: string; body: string; images?: NoteImage[] }; output: NoteResult }
    /** Changes a message of the user that was not sent. */
    'notes.edit': { input: { root: string; id: string; message: string; body: string }; output: NoteResult }
    /** Takes the sent mark off the messages of the send nobody answered. */
    'notes.resend': { input: { root: string; id: string }; output: NoteResult }
    /** Removes one message; the last one takes the thread with it. */
    'notes.remove': { input: { root: string; id: string; message: string }; output: NoteResult }
    'notes.resolve': { input: { root: string; id: string; resolved: boolean }; output: NoteResult }
    /** `all`: every thread of the root, those a cut list did not show too. */
    'notes.delete': { input: { root: string; ids?: string[]; all?: boolean }; output: { ok: boolean; reason?: string } }
    /** The agent that got the repository's last send, when its terminal is open and it is free; null otherwise. */
    'notes.agent': { input: { root: string }; output: { agent: string | null } }
    /** Without `agent`: to the earlier agent, typed into its terminal, when it is free (`done`), else refused. With `agent`: always a new agent of that kind. */
    'notes.send': { input: { root: string; ids: string[]; agent?: string }; output: { ok: true; review: string; to: 'same' | 'new' } | { ok: false; reason: string } }
    'skills.list': { input: { root: string }; output: { skills: string[] } }
    'skills.set': { input: { root: string; skills: string[] }; output: { ok: true; skills: string[] } | { ok: false; reason: string } }
    /** What the skill path field offers in `dir` (full, `~/…`, or from the repository root; '' is the root): subfolders and `.md` files, names only. */
    'skills.browse': { input: { root: string; dir: string }; output: { dirs: string[]; files: string[] } }
    /** One base64 part of an image, in order from `index` 0: every part but the last has exactly 60000 characters, the last 4 to 60000 (a multiple of 4); with `last: true` the image is stored and returned. */
    'images.put': { input: { root: string; upload: string; index: number; last: boolean; data: string; name: string }; output: { ok: true; image?: NoteImage } | { ok: false; reason: string } }
    /** Stores the image file at `path` (full, `~/…`, or from the repository root). */
    'images.attach': { input: { root: string; path: string }; output: { ok: true; image: NoteImage } | { ok: false; reason: string } }
    /** Like `skills.browse`, with image files. */
    'images.browse': { input: { root: string; dir: string }; output: { dirs: string[]; files: string[] } }
    /** Up to 600000 bytes of a stored image from `offset`, base64, and its size; empty with total 0 when there is no such image. */
    'images.get': { input: { root: string; id: string; offset: number }; output: { data: string; total: number } }
  }
  interface PluginPanelEvents {
    'repo.changed': { root: string }
    /** The change request `id` sent to `root` ended; a panel that stopped waiting for it shows `result`. */
    'action.done': { root: string; id: string; result: BranchActionResult }
    /** The worker started, so nothing an earlier one ran will be posted any more. */
    'worker.started': Record<string, never>
    /** The Diff tab of `root` has a new state to show. */
    'diff.show': { root: string }
    /** The file the Diff tab of `root` now shows, for the sidebar to highlight. */
    'diff.current': { root: string; path: string }
    /** The notes of `root` changed. */
    'notes.changed': { root: string }
    /** The Diff tab of `root` now shows commit `hash`, the commit of a note: the panel of `root` selects it and the file `path`. */
    'commit.reveal': { root: string; hash: string; path: string }
  }
}
