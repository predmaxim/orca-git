import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileIconName } from './fileicons.ts'
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
})

test('every mapped icon is vendored', () => {
  for (const path of ['a.ts', 'a.md', 'a.png', 'a.zip', 'a.exe', 'a.tf', 'Jenkinsfile', 'a.cs', 'a.swift']) {
    assert.ok(ICON_SVG[fileIconName(path)], path)
  }
  assert.ok(ICON_SVG.folder && ICON_SVG.folder_dark)
})
