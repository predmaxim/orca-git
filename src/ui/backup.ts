// The backup offer inside the confirmation of a risky operation: a checkbox, branch or tag, and an editable name.
import type { BackupRequest } from '../shared/protocol.ts'
import { h } from './dom.ts'
import { t } from '../shared/i18n.ts'

const pad = (n: number) => String(n).padStart(2, '0')

/** `backup/<branch>-<YYYYMMDD-HHMM>` in local time (`detached-<8 hex>` for a detached HEAD), with `-2`, `-3`… while taken. */
export function suggestBackupName(branch: string | null, head: string, existing: Set<string>, now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  const base = `backup/${branch ?? `detached-${head.slice(0, 8)}`}-${stamp}`
  let name = base
  for (let n = 2; existing.has(name); n++) name = `${base}-${n}`
  return name
}

export interface BackupOptions {
  /** What is backed up: the branch name, or HEAD. */
  label: string
  name: string
  target: string
  kind: 'branch' | 'tag'
  /** Branch and tag names already in use. */
  taken: Set<string>
  /** Called when the person picks branch or tag, to remember the choice. */
  onKind(kind: 'branch' | 'tag'): void
  /** Asks the worker whether git would create this backup: the reason it would not, or null. */
  check(kind: 'branch' | 'tag', name: string): Promise<string | null>
}

export interface BackupBlock {
  element: HTMLElement
  /** Shows or hides "Also save uncommitted changes to the stash" (reset --hard only). */
  showStash(show: boolean): void
  /** Why the dialog can't close, or null. */
  validate(): Promise<string | null>
  /** The backup to make, or undefined when the box is unchecked. */
  value(): BackupRequest | undefined
}

export function backupBlock(options: BackupOptions): BackupBlock {
  let kind = options.kind
  const enabled = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement
  const stash = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement
  const stashRow = h('label', { class: 'checkbox', hidden: true }, stash, t('backupStash'))
  const name = h('input', { class: 'field mono', spellcheck: false, value: options.name, 'aria-label': t('backupNameLabel') }) as HTMLInputElement
  const radio = (value: 'branch' | 'tag', label: string) =>
    h(
      'label',
      null,
      h('input', {
        type: 'radio',
        name: 'backup-kind',
        checked: value === kind,
        onchange: () => {
          kind = value
          options.onKind(value)
        }
      }),
      label
    )
  // A disabled fieldset disables everything in it.
  const details = h(
    'fieldset',
    { class: 'backup-details' },
    h('div', { class: 'backup-kind' }, radio('branch', t('backupKindBranch')), radio('tag', t('backupKindTag'))),
    name,
    h('div', { class: 'muted' }, t('backupHint')),
    stashRow
  ) as HTMLFieldSetElement
  enabled.addEventListener('change', () => (details.disabled = !enabled.checked))
  return {
    element: h('div', { class: 'backup' }, h('label', { class: 'checkbox' }, enabled, t('backupFirst', { name: options.label })), details),
    showStash: (show) => (stashRow.hidden = !show),
    async validate() {
      if (!enabled.checked) return null
      const value = name.value.trim()
      if (!value) return t('backupNameEmpty')
      if (options.taken.has(value)) return t('backupNameTaken', { name: value })
      return options.check(kind, value)
    },
    value() {
      if (!enabled.checked) return undefined
      return { kind, name: name.value.trim(), target: options.target, ...(!stashRow.hidden && stash.checked ? { stash: true } : {}) }
    }
  }
}
