import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { parseAnswer, readAnswers, removeReview, reviewPaths, reviewPrompt, writeReview } from './review.ts'
import { REVIEW_GUIDE } from './reviewGuide.ts'
import { notesKey } from './notes.ts'
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

test('removing a review does not go through a linked .orca-git-log', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const outside = mkdtempSync(join(tmpdir(), 'git-log-outside-'))
  mkdirSync(join(outside, 'review-bbbbbbbbbbbb'))
  writeFileSync(join(outside, 'review-bbbbbbbbbbbb', 'keep.txt'), 'x')
  symlinkSync(outside, join(root, '.orca-git-log'))
  removeReview(root, 'bbbbbbbbbbbb')
  assert.equal(existsSync(join(outside, 'review-bbbbbbbbbbbb', 'keep.txt')), true)
})

test('an answer reads as a verdict, a fixed mark and markdown', () => {
  assert.deepEqual(parseAnswer('verdict: confirmed\nfixed: yes\n\nDone in `a.ts:3`.', 7), { verdict: 'confirmed', fixed: true, body: 'Done in `a.ts:3`.', at: 7 })
  assert.deepEqual(parseAnswer('﻿Fixed: no\r\nVerdict: Refuted\r\n\r\nNo.\r\n', 7), { verdict: 'refuted', fixed: false, body: 'No.', at: 7 })
  assert.deepEqual(parseAnswer('verdict: unclear\n\nWhich file?', 7), { verdict: 'unclear', fixed: false, body: 'Which file?', at: 7 })
  assert.equal(parseAnswer('verdict: maybe\n\nx'), null)
  assert.equal(parseAnswer('Looks fine to me.'), null)
  assert.equal(parseAnswer(`verdict: confirmed\n\n${'b'.repeat(9000)}`)?.body.length, 8000)
})

test('an answer that is a link, too large or not a file is skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const sent = { ...note(), review: 'bbbbbbbbbbbb', sentAt: 1 }
  writeReview(root, 'bbbbbbbbbbbb', [sent])
  const file = join(reviewPaths(root, 'bbbbbbbbbbbb').answers, `${sent.id}.md`)
  const outside = join(mkdtempSync(join(tmpdir(), 'git-log-outside-')), 'a.md')
  writeFileSync(outside, 'verdict: confirmed\n\nx')
  symlinkSync(outside, file)
  assert.equal(readAnswers(root, [sent]).size, 0)
  rmSync(file)
  writeFileSync(file, `verdict: confirmed\n\n${'x'.repeat(70000)}`)
  assert.equal(readAnswers(root, [sent]).size, 0)
  rmSync(file)
  mkdirSync(file)
  assert.equal(readAnswers(root, [sent]).size, 0)
  rmSync(file, { recursive: true })
  writeFileSync(file, 'verdict: confirmed\n\nx')
  assert.equal(readAnswers(root, [sent], 5).get(sent.id)?.at, 5)
  assert.equal(readAnswers(root, [{ ...sent, reply: { verdict: 'unclear', fixed: false, body: '', at: 1 } }]).size, 0)
})

const answerFile = (root: string, review: string, id: string, text: string) => writeFileSync(join(reviewPaths(root, review).answers, `${id}.md`), text)
const status = { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: 1 } as const

test('the agent event brings the answer in', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h, events: ['agent.status.changed'] })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  answerFile(root, sent.review, added.id, 'verdict: refuted\nfixed: no\n\nIt is right as it is.')
  await worker.emit('agent.status.changed', status)
  assert.deepEqual(worker.posts.slice(-1), [{ event: 'notes.changed', payload: { root } }])
  const [stored] = ((await worker.request('notes.list', { root })) as any).notes
  assert.equal(stored.reply.verdict, 'refuted')
  assert.deepEqual(h.data().storage.pending, [])
})

test('a new worker picks up the answer', async () => {
  const root = fixture()
  const first = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const one = await mountWorker(main, { host: first })
  const { note: added } = (await one.request('notes.add', { root, draft: draft() })) as any
  const sent = (await one.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  const second = host(root, undefined, first.data().storage as any)
  const two = await mountWorker(main, { host: second, events: ['agent.status.changed'] })
  answerFile(root, sent.review, added.id, 'verdict: confirmed\nfixed: yes\n\nDone.')
  await two.emit('agent.status.changed', status)
  assert.equal((((await two.request('notes.list', { root })) as any).notes[0]).reply.fixed, true)
  assert.deepEqual(second.data().storage.pending, [])
})

test('one root whose answers cannot be read does not stop the others', async () => {
  const root = fixture()
  const first = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const one = await mountWorker(main, { host: first })
  const { note: added } = (await one.request('notes.add', { root, draft: draft() })) as any
  const sent = (await one.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  const bad = '/nowhere/bad'
  const storage: any = { ...first.data().storage, [notesKey(bad)]: { root: bad, notes: [null] }, pending: [bad, root] }
  const two = await mountWorker(main, { host: host(root, undefined, storage), events: ['agent.status.changed'] })
  answerFile(root, sent.review, added.id, 'verdict: confirmed\n\nDone.')
  await two.emit('agent.status.changed', status)
  assert.deepEqual(two.posts.slice(-1), [{ event: 'notes.changed', payload: { root } }])
  assert.equal((((await two.request('notes.list', { root })) as any).notes[0]).reply.verdict, 'confirmed')
})

test('the list itself picks up an answer', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  answerFile(root, sent.review, added.id, 'verdict: unclear\n\nWhich?')
  assert.equal((((await worker.request('notes.list', { root })) as any).notes[0]).reply.verdict, 'unclear')
})

test('deleting the last note of a review removes its folder', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  await worker.request('notes.delete', { root, ids: [added.id] })
  assert.equal(existsSync(reviewPaths(root, sent.review).dir), false)
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
