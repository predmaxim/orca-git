import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t } from '../shared/i18n.ts'
import { findKey, KEYS, withKey } from './keys.ts'

const press = (code: string, extra: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  code,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra
})
const chord = (k: { code: string; shift?: true }) => `${k.shift ? 'Shift+' : ''}${k.code}`

test('no two keys share a code and Shift in one scope', () => {
  const seen = new Set<string>()
  for (const k of KEYS) {
    const id = `${k.scope} ${chord(k)}`
    assert.ok(!seen.has(id), `${id} is bound twice`)
    seen.add(id)
  }
})

test('an area key never shadows a key that works anywhere', () => {
  const anywhere = new Set(KEYS.filter((k) => k.scope === 'anywhere').map(chord))
  for (const k of KEYS.filter((k) => k.scope === 'commits' || k.scope === 'files')) {
    assert.ok(!anywhere.has(chord(k)), `${k.id} takes ${chord(k)} from the whole panel`)
  }
})

test('findKey matches the physical key and Shift', () => {
  assert.equal(findKey(press('KeyU'), ['anywhere', 'commits'])?.id, 'filterUser')
  assert.equal(findKey(press('KeyU'), ['anywhere', 'files']), null)
  assert.equal(findKey(press('Slash', { shiftKey: true }), ['anywhere'])?.id, 'help')
  assert.equal(findKey(press('KeyF', { shiftKey: true }), ['anywhere'])?.id, 'fetch')
  assert.equal(findKey(press('KeyF'), ['anywhere'])?.id, 'fold')
})

test('modifiers turn every key off', () => {
  for (const code of ['KeyU', 'Digit1']) {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      assert.equal(findKey(press(code, { [modifier]: true }), ['anywhere', 'commits']), null, `${modifier}+${code}`)
    }
  }
})

test('every label is a message', () => {
  for (const k of KEYS) assert.notEqual(t(k.label), k.label, k.id)
})

test('withKey adds the key to a tooltip', () => {
  assert.equal(withKey('User', 'filterUser'), 'User (u)')
})
