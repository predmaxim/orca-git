import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { browseSkills, checkSkills, skillPathAbs } from './skills.ts'
import { fixture, host } from './testkit.ts'

/** A temporary folder holding `files` (empty) and the folders `dirs`. */
function folder(files: string[], dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'git-log-skills-'))
  for (const name of files) writeFileSync(join(root, name), '')
  for (const name of dirs) mkdirSync(join(root, name))
  return root
}

const root = folder(['a.md', 'B.MD', 'c.txt'], ['sub', '.git'])

test('a folder offers its subfolders and .md files', () => {
  assert.deepEqual(browseSkills('', root), { dirs: ['sub'], files: ['B.MD', 'a.md'] })
  assert.deepEqual(browseSkills('missing/', root), { dirs: [], files: [] })
})

test('links count as what they point at, and a broken link is left out', () => {
  const linked = folder([], ['real'])
  writeFileSync(join(linked, 'real', 'x.md'), '')
  symlinkSync(join(linked, 'real'), join(linked, 'to-dir'))
  symlinkSync(join(linked, 'real', 'x.md'), join(linked, 'to-file.md'))
  symlinkSync(join(linked, 'gone.md'), join(linked, 'broken.md'))
  symlinkSync(join(linked, 'loop.md'), join(linked, 'loop.md'))
  assert.deepEqual(browseSkills('', linked), { dirs: ['real', 'to-dir'], files: ['to-file.md'] })
})

test('a path is taken from the home folder, the root, or as it is', () => {
  assert.equal(skillPathAbs('~/x.md', root), join(homedir(), 'x.md'))
  assert.equal(skillPathAbs('sub/s.md', root), join(root, 'sub/s.md'))
  assert.equal(skillPathAbs('/abs/s.md', root), '/abs/s.md')
})

test('a list of skills is trimmed, without repeats, at most ten, and every path exists', () => {
  assert.deepEqual(checkSkills([' a.md ', 'a.md', '', 'sub'], root), { ok: true, skills: ['a.md', 'sub'] })
  assert.equal(checkSkills(['nope.md'], root).ok, false)
  assert.equal(checkSkills(['a.md\nx'], root).ok, false)
  assert.equal(checkSkills('a.md', root).ok, false)
  assert.equal(checkSkills([7], root).ok, false)
  assert.equal(checkSkills(['a'.repeat(1025)], root).ok, false)
  const names = Array.from({ length: 11 }, (_, i) => `s${i}.md`)
  const many = folder(names)
  assert.equal(checkSkills(names, many).ok, false)
  assert.deepEqual(checkSkills(names.slice(0, 10), many), { ok: true, skills: names.slice(0, 10) })
})

test('a path is stored without trailing slashes, so a folder with and without one is one entry', () => {
  assert.deepEqual(checkSkills(['sub/', 'sub', 'sub//', '/'], root), { ok: true, skills: ['sub', '/'] })
})

test('only a path not stored yet has to exist', () => {
  assert.deepEqual(checkSkills(['gone.md', 'a.md'], root, ['gone.md']), { ok: true, skills: ['gone.md', 'a.md'] })
  assert.deepEqual(checkSkills(['gone'], root, ['gone/']), { ok: true, skills: ['gone'] })
  const refused = checkSkills(['gone.md', 'other.md'], root, ['gone.md'])
  assert.equal(refused.ok, false)
  assert.match((refused as { reason: string }).reason, /other\.md/)
})

test('the worker stores the skills of a repository', async () => {
  const repo = fixture()
  writeFileSync(join(repo, 'rules.md'), '# rules')
  const worker = await mountWorker(main, { host: host(repo) })
  assert.deepEqual(await worker.request('skills.set', { root: repo, skills: ['rules.md'] }), { ok: true, skills: ['rules.md'] })
  assert.deepEqual(await worker.request('skills.list', { root: repo }), { skills: ['rules.md'] })
  const refused = (await worker.request('skills.set', { root: repo, skills: ['gone.md'] })) as any
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /gone\.md/)
  assert.deepEqual(await worker.request('skills.list', { root: repo }), { skills: ['rules.md'] })
  assert.ok(((await worker.request('skills.browse', { root: repo, dir: '' })) as any).files.includes('rules.md'))
  assert.deepEqual(worker.refusals, [])
})

test('a stored skill gone from the disk does not block removing another one', async () => {
  const repo = fixture()
  writeFileSync(join(repo, 'rules.md'), '# rules')
  writeFileSync(join(repo, 'b.md'), '# b')
  const worker = await mountWorker(main, { host: host(repo) })
  assert.equal(((await worker.request('skills.set', { root: repo, skills: ['rules.md', 'b.md'] })) as any).ok, true)
  rmSync(join(repo, 'rules.md'))
  assert.deepEqual(await worker.request('skills.set', { root: repo, skills: ['rules.md'] }), { ok: true, skills: ['rules.md'] })
  const refused = (await worker.request('skills.set', { root: repo, skills: ['rules.md', 'gone.md'] })) as any
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /gone\.md/)
  assert.deepEqual(await worker.request('skills.list', { root: repo }), { skills: ['rules.md'] })
})
