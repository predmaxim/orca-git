import { assert, test } from 'orca/testing'
import { en, getLocale, pickLocale, ru, setLocale, t } from './i18n.ts'

test('pickLocale maps Russian tags to ru and everything else to en', () => {
  for (const tag of ['ru', 'ru-RU', 'RU']) assert.equal(pickLocale(tag), 'ru')
  for (const tag of ['en-US', 'de', '', undefined]) assert.equal(pickLocale(tag), 'en')
})

test('t substitutes params and falls back to English', () => {
  const key = 'testGreeting' as never
  ;(en as Record<string, unknown>).testGreeting = 'Hello, {name}'
  try {
    setLocale('ru')
    assert.equal(getLocale(), 'ru')
    assert.equal(t(key, { name: 'Ann' }), 'Hello, Ann')
  } finally {
    delete (en as Record<string, unknown>).testGreeting
    setLocale('en')
  }
})

test('Russian plurals pick one, few and many', () => {
  setLocale('ru')
  try {
    assert.equal(t('commitsSelected', { count: 1 }), 'Выбран 1 коммит')
    assert.equal(t('commitsSelected', { count: 3 }), 'Выбрано 3 коммита')
    assert.equal(t('commitsSelected', { count: 5 }), 'Выбрано 5 коммитов')
    assert.equal(t('commitsSelected', { count: 21 }), 'Выбран 21 коммит')
  } finally {
    setLocale('en')
  }
  assert.equal(t('commitsSelected', { count: 2 }), '2 commits selected')
})

test('every English key has a Russian translation', () => {
  for (const key of Object.keys(en)) {
    assert.ok(key in ru, `missing ru key: ${key}`)
    const value = (ru as Record<string, unknown>)[key]
    if (typeof (en as Record<string, unknown>)[key] === 'object') {
      for (const form of ['one', 'few', 'many']) assert.ok(form in (value as object), `${key}: ru lacks ${form}`)
    }
  }
})
