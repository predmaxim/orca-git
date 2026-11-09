// Thin typed wrapper over the frame's `window.orca` (no Node, no network in a frame).
import type {
  ActionRequest,
  ActionResult,
  BranchAction,
  BranchActionResult,
  CheckResult,
  CommitDetails,
  DiffTabState,
  FileChange,
  FileDiff,
  LogFilter,
  LogPage,
  PatchResult,
  RefsResult,
  RepoResult,
  RewriteKind,
  SelectionFile
} from '../shared/protocol.ts'

interface Disposable {
  dispose(): void
}

interface FrameOrca {
  plugin: {
    request(name: string, input?: unknown, options?: { timeoutMs?: number }): Promise<any>
    on(event: string, handler: (payload: any) => void): Disposable
  }
  on(event: string, handler: (payload: any) => void): Disposable
  locale: string
  host: { has(method: string): boolean; call(method: string, params?: unknown): Promise<any> }
  document?: { get(): Promise<{ content: { kind: string; text?: string } }> }
}

export const orca = (globalThis as unknown as { orca: FrameOrca }).orca

const LONG = { timeoutMs: 120_000 }

// Every request carries the frame language so the worker answers in it.
const call = (name: string, input: object, options?: { timeoutMs?: number }): Promise<any> =>
  orca.plugin.request(name, { ...input, locale: orca.locale }, options)

export const api = {
  resolve: (root?: string, workspaceId?: string): Promise<RepoResult> =>
    call('repo.resolve', root ? { root } : workspaceId ? { workspaceId } : {}),
  refs: (root: string): Promise<RefsResult> => call('repo.refs', { root }),
  watch: (root: string): Promise<{ ok: boolean }> => call('repo.watch', { root }),
  page: (root: string, filter: LogFilter, skip: number, limit?: number): Promise<LogPage> =>
    call('log.page', { root, filter, skip, ...(limit ? { limit } : {}) }, LONG),
  details: (root: string, hash: string): Promise<CommitDetails> => call('commit.details', { root, hash }),
  diff: (root: string, hash: string, file: FileChange, wholeFile: boolean): Promise<FileDiff> =>
    call('file.diff', { root, hash, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), wholeFile }, LONG),
  selectionFiles: (root: string, hashes: string[]): Promise<SelectionFile[]> => call('selection.files', { root, hashes }, LONG),
  rangeDiff: (root: string, file: SelectionFile, wholeFile: boolean): Promise<FileDiff> =>
    call('range.diff', { root, from: file.from, to: file.to, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), wholeFile }, LONG),
  patch: (root: string, hashes: string[], path?: string, overwrite = false): Promise<PatchResult> =>
    call('patch.create', { root, hashes, ...(path ? { path, overwrite } : {}) }, LONG),
  check: (root: string, kind: RewriteKind, hashes: string[]): Promise<CheckResult> =>
    call('action.check', { root, kind, hashes }, LONG),
  // Outlasts the worker's 120 s merge or rebase, so its message arrives instead of a frame timeout.
  branch: (root: string, action: BranchAction): Promise<BranchActionResult> => call('branch.run', { root, action }, { timeoutMs: 150_000 }),
  branchCheck: (root: string, name: string): Promise<{ pushed: string[] }> => call('branch.check', { root, name }, LONG),
  run: (root: string, action: ActionRequest): Promise<ActionResult> => call('action.run', { root, action }, LONG),
  // Outlasts the worker's 120 s git fetch timeout, so its message arrives instead of a frame timeout.
  fetch: (root: string): Promise<ActionResult> => call('repo.fetch', { root }, { timeoutMs: 150_000 }),
  openDiff: (state: DiffTabState): Promise<{ ok: boolean; reason?: string }> => call('diff.open', state),
  diffState: (root: string): Promise<DiffTabState | null> => call('diff.state', { root })
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as Error).message)
  return String(error)
}

/** Copies through a selection: frames refuse navigator.clipboard. Call it from a click or key press. */
export function copyText(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  const focused = document.activeElement as HTMLElement | null
  document.body.append(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  focused?.focus({ preventScroll: true })
  return copied
}
