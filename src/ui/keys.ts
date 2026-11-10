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
  { id: 'wholeFile', code: 'KeyW', shift: true, scope: 'diff', label: 'diffWholeFile', shown: 'Shift+W' }
]

/** The first binding in one of `scopes` for this key; none while Ctrl, Alt or Meta is held. */
export function findKey(
  event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>,
  scopes: KeyScope[]
): KeyBinding | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  return KEYS.find((k) => scopes.includes(k.scope) && k.code === event.code && Boolean(k.shift) === event.shiftKey) ?? null
}

/** A tooltip with its key: "User (u)". */
export function withKey(text: string, id: KeyId): string {
  const key = KEYS.find((k) => k.id === id)
  return key ? `${text} (${key.shown})` : text
}
