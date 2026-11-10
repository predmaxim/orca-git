// The sidebar/Diff tab <-> worker contract. Both sides import these types; nothing here runs.

export interface RepoInfo {
  root: string
  name: string
  workspaceId: string | null
  head: { branch: string | null; hash: string | null }
  /** A sequencer operation left in progress (by a terminal, say); rewrites are refused while set. */
  operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | null
  /** The cherry-pick or revert left only its todo list (.git/sequencer): `--quit` is the way out. */
  todoOnly: boolean
}

/** A local workspace the focused context could be, when several share its name and branch. */
export interface WorkspaceChoice {
  id: string
  name: string
  path: string
  branch: string
}

export type RepoResult = { ok: true; repo: RepoInfo } | { ok: false; reason: string; choices?: WorkspaceChoice[] }

export interface BranchRef {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string
  /** Full ref name: `refs/heads/main`. */
  full: string
  hash: string
  upstream?: string
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
  files: FileChange[]
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
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface PlanItem {
  hash: string
  action: RebaseAction
  /** pick: the final message of its group; reword/squash: this commit's new message. */
  message?: string
}

export type RewriteKind = 'squash' | 'fixup' | 'drop' | 'reword' | 'rebase' | 'undo'

export type ActionRequest =
  /** `track`: a remote branch (full ref) to make `target` from, as a new local branch tracking it. */
  | { kind: 'checkout'; target: string; track?: string }
  | { kind: 'branch'; hash: string; name: string; checkout: boolean }
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

export interface ActionResult {
  ok: boolean
  message: string
  /** HEAD before the action, so the UI can offer Undo. */
  previousHead?: string
  /** The backup branch or tag made before the action, even when the action then failed. */
  backup?: string
  /** The stash commit holding the uncommitted changes saved with the backup. */
  stash?: string
  /** HEAD after an action sent with `expectHead` or a backup ran, for its Undo to expect. */
  head?: string
  /** It ran, but left something for the user to sort out (the message says what); Undo only with `previousHead`. */
  warning?: boolean
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

/** Sent with `action.run` and `branch.run`: the HEAD the confirmation showed, and the backup to make first. */
export interface ActionGuard {
  expectHead?: string
  backup?: BackupRequest
}

export type BranchAction =
  | { kind: 'rename'; name: string; newName: string }
  | { kind: 'delete'; name: string; force: boolean }
  /** `name`: the full ref, refs/heads/… or refs/remotes/… (a short name can mean another ref). */
  | { kind: 'merge'; name: string }
  | { kind: 'rebaseOnto'; name: string }

export interface BranchActionResult extends ActionResult {
  /** The branch is not fully merged; deleting it needs force. */
  needsForce?: boolean
}

export type PatchResult =
  | { ok: true; name: string; size: number; text?: string; tooLarge?: boolean; notUtf8?: boolean; path?: string }
  | { ok: false; reason: string; exists?: boolean }

/** What the Diff tab of a repository shows: the files of the selection a file was opened from. */
export interface DiffTabState {
  root: string
  files: SelectionFile[]
  index: number
}

declare module 'orca' {
  interface PluginRequests {
    'repo.resolve': { input: { root?: string; workspaceId?: string }; output: RepoResult }
    'repo.refs': { input: { root: string }; output: RefsResult }
    'repo.watch': { input: { root: string }; output: { ok: boolean } }
    'log.page': { input: { root: string; filter: LogFilter; skip: number; limit?: number }; output: LogPage }
    'commit.details': { input: { root: string; hash: string }; output: CommitDetails }
    'file.diff': { input: { root: string; hash: string; path: string; oldPath?: string; wholeFile?: boolean }; output: FileDiff }
    'selection.files': { input: { root: string; hashes: string[] }; output: SelectionFile[] }
    'range.diff': { input: { root: string; from: string | null; to: string; path: string; oldPath?: string; wholeFile?: boolean }; output: FileDiff }
    'patch.create': { input: { root: string; hashes: string[]; path?: string; overwrite?: boolean }; output: PatchResult }
    'action.check': { input: { root: string; kind: RewriteKind; hashes: string[] }; output: CheckResult }
    'action.run': { input: { root: string; action: ActionRequest } & ActionGuard; output: ActionResult }
    'branch.run': { input: { root: string; action: BranchAction } & ActionGuard; output: BranchActionResult }
    'backup.delete': { input: { root: string; action: BackupDelete }; output: ActionResult }
    /** Whether `name` can become a new backup branch or tag; read-only. */
    'backup.check': { input: { root: string; kind: 'branch' | 'tag'; name: string }; output: { ok: true } | { ok: false; reason: string } }
    /** What a hard reset to `target` would lose: uncommitted tracked changes, untracked files it overwrites; read-only. */
    'reset.check': { input: { root: string; target: string }; output: ResetCheck }
    /** Remote branches holding commits that rebasing the current branch onto `name` would rewrite. */
    /** `name`: the full ref, as for `rebaseOnto`. */
    'branch.check': { input: { root: string; name: string }; output: { pushed: string[] } }
    'repo.fetch': { input: { root: string }; output: ActionResult }
    /** Shows the state in the Diff tab of the workspace that holds `root`, opening the tab if needed. */
    'diff.open': { input: DiffTabState; output: { ok: boolean; reason?: string } }
    'diff.state': { input: { root: string }; output: DiffTabState | null }
    /** The Diff tab stepped to another file of its state. */
    'diff.index': { input: { root: string; index: number }; output: { ok: boolean } }
  }
  interface PluginPanelEvents {
    'repo.changed': { root: string }
    /** The Diff tab of `root` has a new state to show. */
    'diff.show': { root: string }
    /** The file the Diff tab of `root` now shows, for the sidebar to highlight. */
    'diff.current': { root: string; path: string }
  }
}
