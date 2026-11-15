import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { removeReview, reviewPaths, reviewPrompt, writeReview } from './review.ts'
import { REVIEW_GUIDE } from './reviewGuide.ts'
import { draft, fixture, host } from './testkit.ts'

const note = () => ({ ...draft(), id: 'aaaaaaaaaaaa', createdAt: 1 })

test('a review folder holds the notes, the guide and a place for answers', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const made = writeReview(root, 'bbbbbbbbbbbb', [note()])
  assert.equal(made.ok, true)
  const paths = reviewPaths(root, 'bbbbbbbbbbbb')
  assert.equal(paths.dir, join(root, '.orca-git-log', 'review-bbbbbbbbbbbb'))
  const text = readFileSync(paths.notes, 'utf8')
  for (const part of ['## Note aaaaaaaaaaaa', 'File: src/a.ts', 'Lines: 3-4, new side', `git show ${'c'.repeat(40)}:src/a.ts`, '    x\n    y', 'why?', join(paths.answers, '<note id>.md')]) assert.ok(text.includes(part), part)
  assert.equal(readFileSync(paths.guide, 'utf8'), REVIEW_GUIDE)
  assert.equal(statSync(paths.answers).isDirectory(), true)
})

test('a link or a file in place of the folder is refused and nothing is written through it', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const outside = mkdtempSync(join(tmpdir(), 'git-log-outside-'))
  symlinkSync(outside, join(root, '.orca-git-log'))
  assert.equal(writeReview(root, 'bbbbbbbbbbbb', [note()]).ok, false)
  assert.deepEqual(readdirSync(outside), [])
  const other = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  writeFileSync(join(other, '.orca-git-log'), '')
  assert.equal(writeReview(other, 'bbbbbbbbbbbb', [note()]).ok, false)
})

test('the prompt names three paths, has no backtick and fits', () => {
  const paths = reviewPaths('/r'.repeat(100), 'bbbbbbbbbbbb')
  const prompt = reviewPrompt(paths)
  for (const path of [paths.notes, paths.guide, paths.answers]) assert.ok(prompt.includes(path))
  assert.equal(prompt.includes('`'), false)
  assert.equal(prompt.includes('\n'), false)
  assert.ok(prompt.length <= 4096)
})

test('removing a review leaves everything else', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  writeReview(root, 'bbbbbbbbbbbb', [note()])
  writeReview(root, 'dddddddddddd', [note()])
  removeReview(root, 'bbbbbbbbbbbb')
  assert.equal(existsSync(reviewPaths(root, 'bbbbbbbbbbbb').dir), false)
  assert.equal(existsSync(reviewPaths(root, 'dddddddddddd').notes), true)
  removeReview(root, '../x')
  assert.deepEqual(readdirSync(join(root, '.orca-git-log')), ['review-dddddddddddd'])
})

test('sending launches a new agent and marks the notes', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  assert.equal(sent.ok, true)
  const [call] = h.callsOf('agent.launch') as { workspaceId: string; agent: string; prompt: string }[]
  assert.equal(call.workspaceId, 'wt-1')
  assert.equal(call.agent, 'claude')
  assert.ok(call.prompt.includes(reviewPaths(root, sent.review).notes))
  assert.ok(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.orca-git-log/'))
  assert.equal(((await worker.request('notes.list', { root })) as any).notes[0].review, sent.review)
  assert.deepEqual(worker.refusals, [])
})

test('a launch that fails leaves the notes unsent and no folder', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': () => { throw hostError('action_failed', 'no agent') } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  assert.equal(sent.ok, false)
  assert.equal(((await worker.request('notes.list', { root })) as any).notes[0].sentAt, undefined)
  assert.deepEqual(readdirSync(join(root, '.orca-git-log')), [])
})

test('nothing to send, a bad agent name', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  assert.equal(((await worker.request('notes.send', { root, ids: [], agent: 'claude' })) as any).ok, false)
  assert.equal(((await worker.request('notes.send', { root, ids: [added.id], agent: '--help' })) as any).ok, false)
  assert.equal(h.callsOf('agent.launch').length, 0)
})
