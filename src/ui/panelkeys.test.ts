import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t } from '../shared/i18n.ts'
import type { MenuEntry } from './menu.ts'
import { keyFor } from './keys.ts'
import { entityAction } from './panelkeys.ts'

const drop = keyFor('commitDrop')!
const ran: string[] = []
const entry = (over: Partial<Exclude<MenuEntry, 'separator'>>): MenuEntry => ({ label: 'Drop', key: 'commitDrop', run: () => ran.push('drop'), ...over })

test('a letter runs the menu item with its key', () => {
  ran.length = 0
  const action = entityAction(drop, ['separator', entry({})])
  if (!('run' in action)) throw new Error(`no run: ${JSON.stringify(action)}`)
  action.run()
  assert.deepEqual(ran, ['drop'])
})

test('a letter of a greyed item shows why, and runs nothing', () => {
  ran.length = 0
  assert.deepEqual(entityAction(drop, [entry({ disabled: true, hint: 'Rewrites pushed commits' })]), { notice: 'Rewrites pushed commits' })
  assert.deepEqual(entityAction(drop, [entry({ disabled: true })]), { notice: t('keyUnavailable', { action: t(drop.label) }) })
  assert.deepEqual(ran, [])
})

test('a letter whose item the menu leaves out says it does not apply here', () => {
  assert.deepEqual(entityAction(drop, [entry({ key: 'commitSquash' })]), { notice: t('keyNotHere', { action: t(drop.label) }) })
})

test('a letter with nothing under the cursor asks to pick something', () => {
  assert.deepEqual(entityAction(drop, null), { notice: t('keyNoTarget') })
})
