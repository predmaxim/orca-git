import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../worker/main.ts'
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
    assert.equal(t('commitsCount', { count: 1 }), '1 коммит')
    assert.equal(t('commitsCount', { count: 3 }), '3 коммита')
    assert.equal(t('commitsCount', { count: 5 }), '5 коммитов')
    assert.equal(t('commitsCount', { count: 21 }), '21 коммит')
  } finally {
    setLocale('en')
  }
  assert.equal(t('commitsCount', { count: 2 }), '2 commits')
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

test('worker messages switch to Russian with the request locale', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-i18n-')))
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    sh('init', '-q', '-b', 'main')
    sh('config', 'user.name', 'Tester')
    sh('config', 'user.email', 'tester@example.com')
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(root, `${name}.txt`), name)
      sh('add', '.')
      sh('commit', '-qm', name)
    }
    const worker = await mountWorker(main, { host: mockHost({ results: {} }) })
    const hashes = (n: number) => [sh('rev-parse', `HEAD~${n}`)]
    // The panel adds `locale` to every request (api.ts), which the typed protocol does not list.
    const request = (locale: string) => ({ root, locale, expectHead: sh('rev-parse', 'HEAD'), action: { kind: 'drop' as const, hashes: hashes(1) } })
    const ru = await worker.request('action.run', request('ru'))
    assert.equal(ru.ok, true, ru.message)
    assert.equal(ru.message, 'Удалён 1 коммит.')
    const en = await worker.request('action.run', request('en-US'))
    assert.equal(en.message, 'Dropped 1 commit.')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
