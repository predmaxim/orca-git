import type { PlanItem, RangeCommit, RebaseAction, ResetMode } from '../shared/protocol.ts'
import { h, icon } from './dom.ts'
import { closePopups } from './menu.ts'
import { shortHash } from './format.ts'

interface Button<T> {
  label: string
  value: T
  kind?: 'primary' | 'danger'
}

interface DialogOptions<T> {
  title: string
  body: (HTMLElement | string | null)[]
  buttons: Button<T>[]
  wide?: boolean
  /** Returns an error to keep the dialog open, or null to close with the pressed button's value. */
  validate?: () => string | null
  focus?: HTMLElement
}

/** A modal dialog (frames have no confirm/prompt). Resolves null when cancelled. */
export function dialog<T>(options: DialogOptions<T>): Promise<T | null> {
  closePopups()
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null
    const error = h('div', { class: 'error-text' })
    const finish = (value: T | null) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      previous?.focus({ preventScroll: true })
      resolve(value)
    }
    const press = (button: Button<T>) => {
      if (button.value === null) return finish(null)
      const problem = options.validate?.() ?? null
      if (problem) {
        error.textContent = problem
        return
      }
      finish(button.value)
    }
    const buttons = options.buttons.map((button) =>
      h('button', { class: `btn ${button.kind ?? ''}`, onclick: () => press(button) }, button.label)
    )
    const main = options.buttons.findIndex((b) => b.kind)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
      } else if (event.key === 'Enter' && main >= 0) {
        const target = event.target as HTMLElement
        const multiline = target.tagName === 'TEXTAREA'
        if (target.tagName === 'BUTTON' || target.tagName === 'SELECT') return
        if (multiline && !(event.ctrlKey || event.metaKey)) return
        event.preventDefault()
        press(options.buttons[main])
      }
    }
    const overlay = h(
      'div',
      { class: 'overlay', onmousedown: (event: MouseEvent) => event.target === overlay && finish(null) },
      h(
        'div',
        { class: `dialog${options.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, options.title),
        h('div', { class: 'content' }, ...options.body.map((part) => (typeof part === 'string' ? h('p', null, part) : part)), error),
        h('div', { class: 'buttons' }, ...buttons)
      )
    )
    document.addEventListener('keydown', onKey, true)
    document.body.append(overlay)
    const target = options.focus ?? buttons[main >= 0 ? main : 0]
    requestAnimationFrame(() => target.focus())
  })
}

const cancel = <T>(): Button<T> => ({ label: 'Cancel', value: null as T })

export function pushedWarning(pushed: string[]): HTMLElement {
  const list = pushed.slice(0, 4).join(', ') + (pushed.length > 4 ? ` and ${pushed.length - 4} more` : '')
  return h(
    'div',
    { class: 'warning' },
    icon('warning'),
    h('div', null, `These commits were already pushed to ${list}. Rewriting them will require a force push and may disturb others.`)
  )
}

export async function confirm(title: string, message: string | HTMLElement, ok: string, danger = false): Promise<boolean> {
  const result = await dialog<boolean>({
    title,
    body: [message],
    buttons: [cancel(), { label: ok, value: true, kind: danger ? 'danger' : 'primary' }]
  })
  return result === true
}

export async function editMessage(title: string, initial: string, ok: string, extra: HTMLElement | null = null): Promise<string | null> {
  const area = h('textarea', { class: 'field mono', rows: 10, spellcheck: false }) as HTMLTextAreaElement
  area.value = initial
  const result = await dialog<string>({
    title,
    body: [extra, area, h('div', { class: 'muted' }, 'Ctrl+Enter to confirm.')],
    buttons: [cancel(), { label: ok, value: 'ok', kind: 'primary' }],
    focus: area,
    validate: () => (area.value.trim() ? null : 'The commit message cannot be empty.')
  })
  return result ? area.value.replace(/\s+$/, '') : null
}

export async function askName(
  title: string,
  label: string,
  ok: string,
  checkbox?: { label: string; checked: boolean },
  initial = ''
): Promise<{ name: string; checked: boolean } | null> {
  const input = h('input', { class: 'field', spellcheck: false, placeholder: label, value: initial }) as HTMLInputElement
  const box = checkbox ? (h('input', { type: 'checkbox', checked: checkbox.checked }) as HTMLInputElement) : null
  const result = await dialog<string>({
    title,
    body: [input, box && checkbox ? h('label', { class: 'checkbox' }, box, checkbox.label) : null],
    buttons: [cancel(), { label: ok, value: 'ok', kind: 'primary' }],
    focus: input,
    validate: () => (input.value.trim() ? null : `Enter a ${label.toLowerCase()}.`)
  })
  return result ? { name: input.value.trim(), checked: box?.checked ?? false } : null
}

export type PatchChoice = { action: 'copy' } | { action: 'save'; path: string }

/** "Create Patch": a file path to save to, or copy to the clipboard when the patch is small enough. */
export async function askPatch(count: number, size: number, defaultPath: string, canCopy: boolean): Promise<PatchChoice | null> {
  const input = h('input', { class: 'field mono', spellcheck: false, placeholder: 'File path' }) as HTMLInputElement
  input.value = defaultPath
  const kb = size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`
  const result = await dialog<'copy' | 'save'>({
    title: 'Create Patch',
    body: [
      `${count === 1 ? 'One commit' : `${count} commits`}, ${kb}. Save to a file (relative to the repository root) or copy to the clipboard.`,
      input,
      canCopy ? null : h('div', { class: 'muted' }, 'The patch is too large for the clipboard; save it to a file.')
    ],
    buttons: [cancel(), ...(canCopy ? [{ label: 'Copy to Clipboard', value: 'copy' as const }] : []), { label: 'Save', value: 'save', kind: 'primary' }],
    focus: input,
    validate: () => (input.value.trim() ? null : 'Enter a file path.')
  })
  if (!result) return null
  return result === 'copy' ? { action: 'copy' } : { action: 'save', path: input.value.trim() }
}

const RESET_MODES: { mode: ResetMode; label: string; help: string }[] = [
  { mode: 'soft', label: 'Soft', help: 'Files and the index stay as they are; the reset changes become staged.' },
  { mode: 'mixed', label: 'Mixed', help: 'Files stay as they are; the index is reset, so the changes become unstaged.' },
  { mode: 'hard', label: 'Hard', help: 'Files and the index are reset. All uncommitted changes are lost!' },
  { mode: 'keep', label: 'Keep', help: 'Files that differ are reset; local changes are kept, or the reset is refused.' }
]

export async function askReset(branch: string | null, hash: string): Promise<ResetMode | null> {
  let chosen: ResetMode = 'mixed'
  const radios = RESET_MODES.map(({ mode, label, help }) =>
    h(
      'label',
      { class: 'radio' },
      h('input', { type: 'radio', name: 'mode', checked: mode === chosen, onchange: () => (chosen = mode) }),
      h('strong', null, label),
      h('span', { class: 'help' }, help)
    )
  )
  const result = await dialog<string>({
    title: 'Git Reset',
    body: [`Reset ${branch ? `branch ${branch}` : 'HEAD'} to ${shortHash(hash)}.`, ...radios],
    buttons: [cancel(), { label: 'Reset', value: 'ok', kind: 'primary' }]
  })
  return result ? chosen : null
}

const ACTIONS: RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']

/** The "Interactively Rebase" dialog: oldest first; reorder, change actions, reword. */
export async function askRebasePlan(commits: RangeCommit[], pushed: string[]): Promise<PlanItem[] | null> {
  const items = commits.map((c) => ({ ...c, action: 'pick' as RebaseAction, newMessage: c.message }))
  let selected = 0
  const list = h('div', { class: 'rebase-list', tabindex: 0 })
  const message = h('textarea', { class: 'field mono', rows: 5, spellcheck: false }) as HTMLTextAreaElement
  const messageLabel = h('div', { class: 'muted' })
  message.addEventListener('input', () => (items[selected].newMessage = message.value))

  const render = () => {
    list.replaceChildren(
      ...items.map((item, index) => {
        const select = h(
          'select',
          {
            onchange: (event: Event) => {
              item.action = (event.target as HTMLSelectElement).value as RebaseAction
              selected = index
              render()
            },
            onclick: (event: Event) => event.stopPropagation()
          },
          ...ACTIONS.map((a) => h('option', { value: a, selected: a === item.action }, a))
        )
        return h(
          'div',
          {
            class: `rebase-row ${item.action}${index === selected ? ' selected' : ''}`,
            onclick: () => {
              selected = index
              render()
            }
          },
          select,
          h('span', { class: 'mono muted' }, shortHash(item.hash)),
          h('span', { class: 'subject' }, item.action === 'reword' ? item.newMessage.split('\n')[0] : item.subject)
        )
      })
    )
    const item = items[selected]
    const editable = item.action === 'reword'
    message.disabled = !editable
    message.value = editable ? item.newMessage : item.message
    messageLabel.textContent = editable ? 'New message:' : 'Message (choose "reword" to edit):'
  }
  const move = (delta: number) => {
    const to = selected + delta
    if (to < 0 || to >= items.length) return
    ;[items[selected], items[to]] = [items[to], items[selected]]
    selected = to
    render()
  }
  list.addEventListener('keydown', (event) => {
    if (event.altKey && event.key === 'ArrowUp') move(-1)
    else if (event.altKey && event.key === 'ArrowDown') move(1)
    else if (event.key === 'ArrowUp') selected = Math.max(0, selected - 1)
    else if (event.key === 'ArrowDown') selected = Math.min(items.length - 1, selected + 1)
    else {
      const action = { p: 'pick', r: 'reword', s: 'squash', f: 'fixup', d: 'drop' }[event.key.toLowerCase()] as RebaseAction | undefined
      if (!action) return
      items[selected].action = action
    }
    event.preventDefault()
    render()
  })
  render()
  const tools = h(
    'div',
    { class: 'rebase-tools' },
    h('button', { class: 'tool', title: 'Move up (Alt+↑)', onclick: () => move(-1) }, icon('up')),
    h('button', { class: 'tool', title: 'Move down (Alt+↓)', onclick: () => move(1) }, icon('down')),
    h('span', { class: 'muted' }, 'Oldest commit first. Keys: P pick, R reword, S squash, F fixup, D drop.')
  )
  const result = await dialog<string>({
    title: 'Interactively Rebase',
    wide: true,
    body: [pushed.length ? pushedWarning(pushed) : null, tools, list, messageLabel, message],
    buttons: [cancel(), { label: 'Start Rebasing', value: 'ok', kind: 'primary' }],
    focus: list,
    validate: () => {
      const kept = items.filter((i) => i.action !== 'drop')
      if (!kept.length) return 'Keep at least one commit, or use Drop instead.'
      if (kept[0].action === 'squash' || kept[0].action === 'fixup') return `The first kept commit cannot be a ${kept[0].action}.`
      if (items.some((i) => i.action === 'reword' && !i.newMessage.trim())) return 'A commit message cannot be empty.'
      return null
    }
  })
  if (!result) return null
  return items.map((item) => ({
    hash: item.hash,
    action: item.action,
    ...(item.action === 'reword' ? { message: item.newMessage.replace(/\s+$/, '') } : {})
  }))
}

/** A non-dismissable spinner while the worker runs a long action. */
export function busy(text: string): () => void {
  const el = h('div', { class: 'busy' }, h('div', { class: 'pill' }, h('div', { class: 'spin' }), text))
  document.body.append(el)
  return () => el.remove()
}
