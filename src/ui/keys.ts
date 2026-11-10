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
  | 'expandAll'
  | 'collapseAll'
  | 'split'
  | 'unified'
  | 'wholeFile'

/** `code` is the physical key (`event.code`), so a letter works in any keyboard layout. */
export interface KeyBinding {
  id: KeyId
  code: string
  shift?: true
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
  { id: 'fold', code: 'KeyF', scope: 'anywhere', label: 'keyFold', shown: 'f' },
  { id: 'search', code: 'Slash', scope: 'anywhere', label: 'keySearch', shown: '/' },
  { id: 'refresh', code: 'KeyR', scope: 'anywhere', label: 'refresh', shown: 'r' },
  { id: 'fetch', code: 'KeyF', shift: true, scope: 'anywhere', label: 'fetch', shown: 'Shift+F' },
  { id: 'help', code: 'Slash', shift: true, scope: 'anywhere', label: 'keyHelp', shown: '?' },
  { id: 'filterBranch', code: 'KeyB', scope: 'commits', label: 'filterBranch', shown: 'b' },
  { id: 'filterUser', code: 'KeyU', scope: 'commits', label: 'filterUser', shown: 'u' },
  { id: 'filterDate', code: 'KeyD', scope: 'commits', label: 'filterDate', shown: 'd' },
  { id: 'filterPaths', code: 'KeyP', scope: 'commits', label: 'filterPaths', shown: 'p' },
  { id: 'regex', code: 'Period', scope: 'commits', label: 'regexTip', shown: '.' },
  { id: 'matchCase', code: 'KeyC', scope: 'commits', label: 'matchCaseTip', shown: 'c' },
  { id: 'expandAll', code: 'KeyE', scope: 'files', label: 'expandAll', shown: 'e' },
  { id: 'collapseAll', code: 'KeyC', scope: 'files', label: 'collapseAll', shown: 'c' },
  { id: 'split', code: 'KeyS', scope: 'diff', label: 'diffSplit', shown: 's' },
  { id: 'unified', code: 'KeyU', scope: 'diff', label: 'diffUnified', shown: 'u' },
  { id: 'wholeFile', code: 'KeyW', scope: 'diff', label: 'diffWholeFile', shown: 'w' }
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
