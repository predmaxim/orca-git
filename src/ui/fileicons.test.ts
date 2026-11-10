import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BY_EXT, BY_NAME, fileIconName } from './fileicons.ts'
import { ICON_SVG } from './fileicons-data.ts'

test('file icons are picked by name, then extension, else unknown', () => {
  assert.equal(fileIconName('Dockerfile'), 'docker')
  assert.equal(fileIconName('web/app/.gitignore'), 'gitignore')
  assert.equal(fileIconName('web/package.json'), 'json')
  assert.equal(fileIconName('tsconfig.json'), 'typeScript')
  assert.equal(fileIconName('src/types/api.d.ts'), 'typeScript')
  assert.equal(fileIconName('src/App.TSX'), 'typeScript')
  assert.equal(fileIconName('docs.v2/Makefile'), 'unknown')
  assert.equal(fileIconName('.bashrc'), 'unknown')
  assert.equal(fileIconName('notes.zzz'), 'unknown')
  for (const path of ['constructor', '__proto__', 'x.toString', 'x.constructor', 'toString']) assert.equal(fileIconName(path), 'unknown', path)
})

test('every mapped icon is vendored', () => {
  for (const name of [...Object.values(BY_NAME), ...Object.values(BY_EXT), 'unknown', 'folder']) assert.ok(Object.hasOwn(ICON_SVG, name), name)
})
