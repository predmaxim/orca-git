import type { PlanItem, RangeCommit, RebaseAction, ResetCheck, ResetMode } from '../shared/protocol.ts'
import type { BackupBlock } from './backup.ts'
import { h, icon } from './dom.ts'
import { closePopups } from './menu.ts'
import { shortHash } from './format.ts'
import { t } from '../shared/i18n.ts'

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
  validate?: () => string | null | Promise<string | null>
  focus?: HTMLElement
}

/** A modal dialog (frames have no confirm/prompt). Resolves null when cancelled. */
export function dialog<T>(options: DialogOptions<T>): Promise<T | null> {
  closePopups()
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null
    const error = h('div', { class: 'error-text' })
    let closed = false
    let checking = false
    const finish = (value: T | null) => {
      if (closed) return
      closed = true
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      previous?.focus({ preventScroll: true })
      resolve(value)
    }
    /** Awaits a check that asks the worker with the dialog frozen, so nothing changes unchecked; Cancel and Escape still work. */
    const waitFor = async (check: Promise<string | null>): Promise<string | null> => {
      checking = true
      const focused = document.activeElement as HTMLElement | null
      const frozen = Array.from(overlay.querySelectorAll<HTMLInputElement>('input, textarea, select, button')).filter(
        (el) => !el.disabled && !buttons.some((button, i) => button === el && options.buttons[i].value === null)
      )
      for (const el of frozen) el.disabled = true
      error.classList.add('pending')
      error.textContent = t('checking')
      try {
        return (await check) ?? null
      } catch (failure) {
        return messageOf(failure)
      } finally {
        checking = false
        for (const el of frozen) el.disabled = false
        error.classList.remove('pending')
        error.textContent = ''
        if (!closed) focused?.focus({ preventScroll: true })
      }
    }
    const press = async (button: Button<T>) => {
      if (button.value === null) return finish(null)
      if (checking) return
      // A check that throws keeps the dialog open with its message, like one that fails.
      let problem: string | null | Promise<string | null>
      try {
        problem = options.validate?.() ?? null
      } catch (failure) {
        problem = messageOf(failure)
      }
      if (problem instanceof Promise) problem = await waitFor(problem)
      if (closed) return
      if (problem) {
        error.textContent = problem
        return
      }
      finish(button.value)
    }
    const buttons = options.buttons.map((button) =>
      h('button', { class: `btn ${button.kind ?? ''}`, onclick: () => void press(button) }, button.label)
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
        void press(options.buttons[main])
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

const cancel = <T>(): Button<T> => ({ label: t('cancel'), value: null as T })

// Never empty: an empty problem would close the dialog as if the check passed.
const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)) || t('checkFailed')

export function pushedWarning(pushed: string[]): HTMLElement {
  const list = pushed.slice(0, 4).join(', ') + (pushed.length > 4 ? t('pushedMore', { count: pushed.length - 4 }) : '')
  return h(
    'div',
    { class: 'warning' },
    icon('warning'),
    h('div', null, t('pushedWarning', { list }))
  )
}

export async function confirm(title: string, message: string | HTMLElement | (string | HTMLElement | null)[], ok: string, danger = false, backup?: BackupBlock): Promise<boolean> {
  const result = await dialog<boolean>({
    title,
    body: [...[message].flat(), backup?.element ?? null],
    buttons: [cancel(), { label: ok, value: true, kind: danger ? 'danger' : 'primary' }],
    validate: () => backup?.validate() ?? null
  })
  return result === true
}

export async function editMessage(title: string, initial: string, ok: string, extra: HTMLElement | null = null, backup?: BackupBlock): Promise<string | null> {
  const area = h('textarea', { class: 'field mono', rows: 10, spellcheck: false }) as HTMLTextAreaElement
  area.value = initial
  const result = await dialog<string>({
    title,
    body: [extra, area, h('div', { class: 'muted' }, t('ctrlEnterHint')), backup?.element ?? null],
    buttons: [cancel(), { label: ok, value: 'ok', kind: 'primary' }],
    focus: area,
    validate: () => (area.value.trim() ? backup?.validate() ?? null : t('commitMessageEmpty'))
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
    validate: () => (input.value.trim() ? null : t('enterField', { label: label.toLowerCase() }))
  })
  return result ? { name: input.value.trim(), checked: box?.checked ?? false } : null
}

export type PatchChoice = { action: 'copy' } | { action: 'save'; path: string }

/** "Create Patch": a file path to save to, or copy to the clipboard when the patch is small enough. */
export async function askPatch(count: number, size: number, defaultPath: string, canCopy: boolean): Promise<PatchChoice | null> {
  const input = h('input', { class: 'field mono', spellcheck: false, placeholder: t('filePathPlaceholder') }) as HTMLInputElement
  input.value = defaultPath
  const kb = size < 1024 ? t('sizeBytes', { n: size }) : t('sizeKilobytes', { n: Math.round(size / 1024) })
  const result = await dialog<'copy' | 'save'>({
    title: t('createPatchTitle'),
    body: [
      t('patchIntro', { count, size: kb }),
      input,
      canCopy ? null : h('div', { class: 'muted' }, t('patchTooLarge'))
    ],
    buttons: [cancel(), ...(canCopy ? [{ label: t('copyToClipboard'), value: 'copy' as const }] : []), { label: t('save'), value: 'save', kind: 'primary' }],
    focus: input,
    validate: () => (input.value.trim() ? null : t('enterFilePath'))
  })
  if (!result) return null
  return result === 'copy' ? { action: 'copy' } : { action: 'save', path: input.value.trim() }
}

const resetModes = (): { mode: ResetMode; label: string; help: string }[] => [
  { mode: 'soft', label: 'Soft', help: t('resetSoftHelp') },
  { mode: 'mixed', label: 'Mixed', help: t('resetMixedHelp') },
  { mode: 'hard', label: 'Hard', help: t('resetHardHelp') },
  { mode: 'keep', label: 'Keep', help: t('resetKeepHelp') }
]

/**
 * What a hard reset destroys besides tracked changes, at most 10 paths per list: nested repositories it
 * deletes whole first, then folders it deletes that could not be fully checked for them, then submodules
 * submodule.recurse makes it reset, then edited files git assumes unchanged (or that the index was too large
 * to check), then untracked files; null when there is none. `stash`: the dialog offers the stash, which
 * does not keep the files.
 */
export function overwrittenWarning(state: ResetCheck, stash: boolean): HTMLElement | null {
  const { overwritten, repositories, unchecked = [], submodules = [], assumeUnchanged = [], indexUnchecked } = state
  if (!overwritten.length && !repositories.length && !unchecked.length && !submodules.length && !assumeUnchanged.length && !indexUnchecked) return null
  const list = (paths: string[]) => [
    h('ul', { class: 'file-list mono' }, ...paths.slice(0, 10).map((path) => h('li', null, path))),
    paths.length > 10 ? t('pushedMore', { count: paths.length - 10 }).trim() : null
  ]
  return h(
    'div',
    { class: 'warning danger' },
    icon('warning'),
    h(
      'div',
      null,
      ...(repositories.length ? [h('strong', null, t('hardResetRepositories', { count: repositories.length })), ...list(repositories)] : []),
      ...(unchecked.length ? [h('strong', null, t('hardResetUnchecked', { count: unchecked.length })), ...list(unchecked)] : []),
      ...(submodules.length ? [h('strong', null, t('hardResetSubmodules', { count: submodules.length })), ...list(submodules)] : []),
      ...(assumeUnchanged.length ? [h('strong', null, t('hardResetAssumeUnchanged', { count: assumeUnchanged.length })), ...list(assumeUnchanged)] : []),
      indexUnchecked ? h('div', null, h('strong', null, t('hardResetIndexUnchecked'))) : null,
      ...(overwritten.length ? [t(stash ? 'hardResetOverwrittenStash' : 'hardResetOverwritten', { count: overwritten.length }), ...list(overwritten)] : [])
    )
  )
}

/** `state`: what a hard reset would lose; the stash offer and the overwritten files show with Hard. */
export async function askReset(branch: string | null, hash: string, backup?: BackupBlock, state?: ResetCheck): Promise<ResetMode | null> {
  let chosen: ResetMode = 'mixed'
  // The warning shows with Hard, and so does the stash row whenever there is a backup offer and something to stash.
  const overwritten = state ? overwrittenWarning(state, Boolean(backup && state.dirty)) : null
  const choose = (mode: ResetMode) => {
    chosen = mode
    backup?.showStash(mode === 'hard' && Boolean(state?.dirty))
    if (overwritten) overwritten.style.display = mode === 'hard' ? '' : 'none'
  }
  choose(chosen)
  const radios = resetModes().map(({ mode, label, help }) =>
    h(
      'label',
      { class: 'radio' },
      h('input', { type: 'radio', name: 'mode', checked: mode === chosen, onchange: () => choose(mode) }),
      h('strong', null, label),
      h('span', { class: 'help' }, help)
    )
  )
  const result = await dialog<string>({
    title: t('resetTitle'),
    body: [branch ? t('resetBranchTo', { name: branch, hash: shortHash(hash) }) : t('resetHeadTo', { hash: shortHash(hash) }), ...radios, overwritten, backup?.element ?? null],
    buttons: [cancel(), { label: t('reset'), value: 'ok', kind: 'primary' }],
    validate: () => backup?.validate() ?? null
  })
  return result ? chosen : null
}

const ACTIONS: RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']

/** The "Interactively Rebase" dialog: oldest first; reorder, change actions, reword. */
export async function askRebasePlan(commits: RangeCommit[], pushed: string[], backup?: BackupBlock): Promise<PlanItem[] | null> {
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
    messageLabel.textContent = editable ? t('rebaseNewMessage') : t('rebaseMessageHint')
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
    h('button', { class: 'tool', title: t('moveUpTip'), onclick: () => move(-1) }, icon('up')),
    h('button', { class: 'tool', title: t('moveDownTip'), onclick: () => move(1) }, icon('down')),
    h('span', { class: 'muted' }, t('rebaseHint'))
  )
  const result = await dialog<string>({
    title: t('rebaseTitle'),
    wide: true,
    body: [pushed.length ? pushedWarning(pushed) : null, tools, list, messageLabel, message, backup?.element ?? null],
    buttons: [cancel(), { label: t('rebaseStart'), value: 'ok', kind: 'primary' }],
    focus: list,
    validate: () => {
      const kept = items.filter((i) => i.action !== 'drop')
      if (!kept.length) return t('rebaseKeepOne')
      if (kept[0].action === 'squash' || kept[0].action === 'fixup') return t('rebaseFirstKept', { action: kept[0].action })
      if (items.some((i) => i.action === 'reword' && !i.newMessage.trim())) return t('commitMessageEmpty')
      return backup?.validate() ?? null
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
