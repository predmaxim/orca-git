// The panel's and the Diff tab's keys in one table: the key handlers and the ? help are both read from it.
import type { MessageKey } from '../shared/i18n.ts'
import type { SectionId } from './sections.ts'

export type KeyScope = 'anywhere' | SectionId | 'diff'
export type KeyId =
  | 'area1'
  | 'area2'
  | 'area3'
  | 'area4'
  | 'diff'
  | 'fold'
  | 'search'
  | 'refresh'
  | 'fetch'
  | 'help'
  | 'filterBranch'
  | 'filterUser'
  | 'filterDate'
  | 'filterPaths'
  | 'regex'
  | 'matchCase'
  | 'folders'
  | 'layout'
  | 'wholeFile'
  | 'commitCopy'
  | 'commitCherryPick'
  | 'commitPatch'
  | 'commitCheckout'
  | 'commitReset'
  | 'commitRevert'
  | 'commitUndo'
  | 'commitReword'
  | 'commitFixup'
  | 'commitSquash'
  | 'commitDrop'
  | 'commitRebase'
  | 'commitBranch'
  | 'commitTag'
  | 'branchCheckout'
  | 'branchNew'
  | 'branchShowOnly'
  | 'branchCopy'
  | 'branchRename'
  | 'branchDelete'
  | 'branchMerge'
  | 'branchRebase'
  | 'branchRestore'

/**
 * `code` is the physical key (`event.code`), so a letter works in any keyboard layout. The rule: a letter without
 * Shift acts on the thing under the cursor (`menu`: it runs that thing's menu item); a letter with Shift acts on the
 * panel or the area, and pressed again undoes it.
 */
export interface KeyBinding {
  id: KeyId
  code: string
  shift?: true
  /** Runs the item with this key in the menu of the commits or branch under the cursor. */
  menu?: true
  scope: KeyScope
  label: MessageKey
  shown: string
}

export const KEYS: readonly KeyBinding[] = [
  { id: 'area1', code: 'Digit1', scope: 'anywhere', label: 'sectionBranches', shown: '1' },
  { id: 'area2', code: 'Digit2', scope: 'anywhere', label: 'sectionCommits', shown: '2' },
  { id: 'area3', code: 'Digit3', scope: 'anywhere', label: 'sectionFiles', shown: '3' },
  { id: 'area4', code: 'Digit4', scope: 'anywhere', label: 'sectionDetails', shown: '4' },
  { id: 'diff', code: 'Digit0', scope: 'anywhere', label: 'keyDiffTab', shown: '0' },
  { id: 'search', code: 'Slash', scope: 'anywhere', label: 'keySearch', shown: '/' },
  { id: 'help', code: 'Slash', shift: true, scope: 'anywhere', label: 'keyHelp', shown: '?' },
  { id: 'fold', code: 'KeyZ', shift: true, scope: 'anywhere', label: 'keyFold', shown: 'Shift+Z' },
  { id: 'refresh', code: 'KeyR', shift: true, scope: 'anywhere', label: 'refresh', shown: 'Shift+R' },
  { id: 'fetch', code: 'KeyF', shift: true, scope: 'anywhere', label: 'fetch', shown: 'Shift+F' },
  { id: 'filterBranch', code: 'KeyB', shift: true, scope: 'commits', label: 'keyFilterBranch', shown: 'Shift+B' },
  { id: 'filterUser', code: 'KeyU', shift: true, scope: 'commits', label: 'keyFilterUser', shown: 'Shift+U' },
  { id: 'filterDate', code: 'KeyD', shift: true, scope: 'commits', label: 'keyFilterDate', shown: 'Shift+D' },
  { id: 'filterPaths', code: 'KeyP', shift: true, scope: 'commits', label: 'keyFilterPaths', shown: 'Shift+P' },
  { id: 'regex', code: 'KeyX', shift: true, scope: 'commits', label: 'regexTip', shown: 'Shift+X' },
  { id: 'matchCase', code: 'KeyC', shift: true, scope: 'commits', label: 'matchCaseTip', shown: 'Shift+C' },
  { id: 'folders', code: 'KeyE', shift: true, scope: 'files', label: 'keyFolders', shown: 'Shift+E' },
  { id: 'layout', code: 'KeyS', shift: true, scope: 'diff', label: 'keyLayout', shown: 'Shift+S' },
  { id: 'wholeFile', code: 'KeyW', shift: true, scope: 'diff', label: 'diffWholeFile', shown: 'Shift+W' },
  { id: 'commitCopy', code: 'KeyY', menu: true, scope: 'commits', label: 'keyCopyRevision', shown: 'y' },
  { id: 'commitCherryPick', code: 'KeyC', menu: true, scope: 'commits', label: 'cmCherryPick', shown: 'c' },
  { id: 'commitPatch', code: 'KeyP', menu: true, scope: 'commits', label: 'cmCreatePatch', shown: 'p' },
  { id: 'commitCheckout', code: 'KeyO', menu: true, scope: 'commits', label: 'checkoutRevision', shown: 'o' },
  { id: 'commitReset', code: 'KeyG', menu: true, scope: 'commits', label: 'cmResetHere', shown: 'g' },
  { id: 'commitRevert', code: 'KeyV', menu: true, scope: 'commits', label: 'keyRevert', shown: 'v' },
  { id: 'commitUndo', code: 'KeyZ', menu: true, scope: 'commits', label: 'cmUndoCommit', shown: 'z' },
  { id: 'commitReword', code: 'KeyR', menu: true, scope: 'commits', label: 'cmEditMessage', shown: 'r' },
  { id: 'commitFixup', code: 'KeyF', menu: true, scope: 'commits', label: 'keyFixup', shown: 'f' },
  { id: 'commitSquash', code: 'KeyS', menu: true, scope: 'commits', label: 'cmSquash', shown: 's' },
  { id: 'commitDrop', code: 'KeyD', menu: true, scope: 'commits', label: 'keyDrop', shown: 'd' },
  { id: 'commitRebase', code: 'KeyI', menu: true, scope: 'commits', label: 'cmRebase', shown: 'i' },
  { id: 'commitBranch', code: 'KeyN', menu: true, scope: 'commits', label: 'cmNewBranch', shown: 'n' },
  { id: 'commitTag', code: 'KeyT', menu: true, scope: 'commits', label: 'cmNewTag', shown: 't' },
  { id: 'branchCheckout', code: 'KeyO', menu: true, scope: 'branches', label: 'checkout', shown: 'o' },
  { id: 'branchNew', code: 'KeyN', menu: true, scope: 'branches', label: 'cmNewBranch', shown: 'n' },
  { id: 'branchShowOnly', code: 'KeyL', menu: true, scope: 'branches', label: 'keyShowOnly', shown: 'l' },
  { id: 'branchCopy', code: 'KeyY', menu: true, scope: 'branches', label: 'copyName', shown: 'y' },
  { id: 'branchRename', code: 'KeyR', menu: true, scope: 'branches', label: 'branchRename', shown: 'r' },
  { id: 'branchDelete', code: 'KeyD', menu: true, scope: 'branches', label: 'branchDelete', shown: 'd' },
  { id: 'branchMerge', code: 'KeyM', menu: true, scope: 'branches', label: 'branchMerge', shown: 'm' },
  { id: 'branchRebase', code: 'KeyB', menu: true, scope: 'branches', label: 'branchRebase', shown: 'b' },
  { id: 'branchRestore', code: 'KeyG', menu: true, scope: 'branches', label: 'keyRestoreBackup', shown: 'g' }
]
// Kept for the file actions to come: o (open in the editor), y (copy the path), v (viewed), h (history).

type Press = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>

/** Whether `event` is the key of `binding`; never while Ctrl, Alt or Meta is held. */
const pressed = (binding: KeyBinding, event: Press) =>
  !event.ctrlKey && !event.altKey && !event.metaKey && binding.code === event.code && Boolean(binding.shift) === event.shiftKey

/** The first binding in one of `scopes` for this key; none while Ctrl, Alt or Meta is held. */
export function findKey(event: Press, scopes: KeyScope[]): KeyBinding | null {
  return KEYS.find((k) => scopes.includes(k.scope) && pressed(k, event)) ?? null
}

export const keyFor = (id: KeyId | undefined): KeyBinding | undefined => KEYS.find((k) => k.id === id)

/** The entry (a menu item) whose key this is. */
export function pickByKey<T extends { key?: KeyId }>(entries: T[], event: Press): T | undefined {
  return entries.find((entry) => {
    const binding = keyFor(entry.key)
    return binding !== undefined && pressed(binding, event)
  })
}

/** A tooltip with its key: "User (u)". */
export function withKey(text: string, id: KeyId): string {
  const key = keyFor(id)
  return key ? `${text} (${key.shown})` : text
}
