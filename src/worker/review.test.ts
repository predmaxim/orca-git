import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'
import { parseAnswer, promptRefusal, readAnswers, removeReview, reviewPaths, reviewPrompt, writeReview } from './review.ts'
import { REVIEW_GUIDE } from './reviewGuide.ts'
import { t } from '../shared/i18n.ts'
import type { NoteReply } from '../shared/protocol.ts'
import { notesKey } from './notes.ts'
import { draft, fixture, host, refusingStorage } from './testkit.ts'

const note = () => ({ ...draft(), id: 'aaaaaaaaaaaa', createdAt: 1 })
const ONCE = 'Write each answer file once, when you are done with that note — after the fix, if you make one.'

test('a review folder holds the notes, the guide and a place for answers', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const made = writeReview(root, 'bbbbbbbbbbbb', [note()])
  assert.equal(made.ok, true)
  const paths = reviewPaths(root, 'bbbbbbbbbbbb')
  assert.equal(paths.dir, join(root, '.orca-git-log', 'review-bbbbbbbbbbbb'))
  const text = readFileSync(paths.notes, 'utf8')
  for (const part of ['## Note aaaaaaaaaaaa', 'File: src/a.ts', 'Lines: 3-4, new side', `git show ${'c'.repeat(40)}:src/a.ts`, '    x\n    y', 'why?', join(paths.answers, '<note id>.md'), ONCE]) assert.ok(text.includes(part), part)
  assert.equal(readFileSync(paths.guide, 'utf8'), REVIEW_GUIDE)
  assert.ok(REVIEW_GUIDE.includes(ONCE))
  for (const part of ['Keep the answer very short, with no filler.', 'a screenshot of the design mockup']) assert.ok(REVIEW_GUIDE.includes(part), part)
  assert.ok(!REVIEW_GUIDE.includes('confidence'))
  assert.ok(text.includes('very short and with no filler') && !text.includes('confidence'))
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
  for (const withSkills of [false, true]) {
    const prompt = reviewPrompt(paths, withSkills)
    for (const path of [paths.notes, paths.guide, paths.answers]) assert.ok(prompt.includes(path))
    assert.equal(prompt.includes('`'), false)
    assert.equal(prompt.includes('\n'), false)
    assert.ok(prompt.length <= 4096)
    assert.equal(promptRefusal(prompt), null)
  }
})

test('a repository path with a control character or a backtick is refused, as is a prompt too long', () => {
  for (const root of ['/r/a`b', '/r/a\nb', '/r/a\tb', '/r/a\x7fb']) assert.equal(promptRefusal(reviewPrompt(reviewPaths(root, 'bbbbbbbbbbbb'))), t('reviewPathUnusable'), JSON.stringify(root))
  assert.equal(promptRefusal(reviewPrompt(reviewPaths('/r', 'bbbbbbbbbbbb'))), null)
  assert.equal(promptRefusal(reviewPrompt(reviewPaths('/r'.repeat(2100), 'bbbbbbbbbbbb'))), t('reviewPromptTooLong'))
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
  assert.deepEqual(parseAnswer('\uFEFFFixed: no\r\nVerdict: Refuted\r\n\r\nNo.\r\n', 7), { verdict: 'refuted', fixed: false, body: 'No.', at: 7 })
  assert.deepEqual(parseAnswer('verdict: unclear\n\nWhich file?', 7), { verdict: 'unclear', fixed: false, body: 'Which file?', at: 7 })
  assert.equal(parseAnswer('verdict: maybe\n\nx'), null)
  assert.equal(parseAnswer('Looks fine to me.'), null)
  assert.equal(parseAnswer(`verdict: confirmed\n\n${'b'.repeat(9000)}`)?.body.length, 8000)
})

test('an answer may carry the markdown agents decorate it with', () => {
  const cases: [string, NoteReply | null][] = [
    ['verdict: **confirmed**\nfixed: yes\n\nok', { verdict: 'confirmed', fixed: true, body: 'ok', at: 7 }],
    ['`verdict`: confirmed\n`fixed`: `true`\n\nok', { verdict: 'confirmed', fixed: true, body: 'ok', at: 7 }],
    ['**verdict:** refuted\n**fixed:** no\n\nok', { verdict: 'refuted', fixed: false, body: 'ok', at: 7 }],
    ['verdict: Confirmed.\nfixed: "yes"\n\nok', { verdict: 'confirmed', fixed: true, body: 'ok', at: 7 }],
    ['# Answer\n\nverdict: refuted\n\nno', { verdict: 'refuted', fixed: false, body: 'no', at: 7 }],
    ['\n\nverdict: unclear\n\nwhat?', { verdict: 'unclear', fixed: false, body: 'what?', at: 7 }],
    ['verdict: confirmed\nfixed: yes\n   \nthe body', { verdict: 'confirmed', fixed: true, body: 'the body', at: 7 }],
    ['verdict: confirmed', { verdict: 'confirmed', fixed: false, body: '', at: 7 }],
    ['verdict: unclear\nverdict: confirmed\nfixed: yes\nfixed: no', { verdict: 'unclear', fixed: true, body: '', at: 7 }],
    ['verdict: confirmed\nLooks fine', null],
    ['verdict: confirmed\nconfidence: 90\n\nok', null],
    ['# Answer\n# Again\n\nverdict: confirmed', null]
  ]
  for (const [text, reply] of cases) assert.deepEqual(parseAnswer(text, 7), reply, JSON.stringify(text))
  // Cut before a pair that would not fit, not inside it.
  assert.equal(parseAnswer(`verdict: confirmed\n\n${'b'.repeat(7999)}\u{1F600}`)?.body, 'b'.repeat(7999))
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
  // An answered note is read again: the agent may have rewritten its answer.
  assert.equal(readAnswers(root, [{ ...sent, reply: { verdict: 'unclear', fixed: false, body: '', at: 1 } }]).size, 1)
})

test('a stored note id that is not 12 hex reads no answer', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  writeReview(root, 'bbbbbbbbbbbb', [note()])
  // Where answers/../x.md lands.
  writeFileSync(join(reviewPaths(root, 'bbbbbbbbbbbb').dir, 'x.md'), 'verdict: confirmed\n\nx')
  assert.equal(readAnswers(root, [{ ...note(), id: '../x', review: 'bbbbbbbbbbbb', sentAt: 1 }]).size, 0)
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

test('an answer the agent rewrites replaces the stored one; an unchanged one is left alone', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  const list = async () => (await worker.request('notes.list', { root })) as any
  answerFile(root, sent.review, added.id, 'verdict: confirmed\nfixed: no\n\nLooking into it.')
  assert.equal((await list()).notes[0].reply.fixed, false)
  answerFile(root, sent.review, added.id, 'verdict: confirmed\nfixed: yes\n\nFixed in a.ts.')
  const posted = worker.posts.length
  const listed = await list()
  assert.equal(listed.notes[0].reply.fixed, true)
  assert.equal(listed.notes[0].reply.body, 'Fixed in a.ts.')
  assert.equal(listed.warning, undefined)
  assert.equal(worker.posts.length, posted + 1)
  // Listed again with the file unchanged: nothing is written, nothing posted, the time it was read stays.
  assert.equal((await list()).notes[0].reply.at, listed.notes[0].reply.at)
  assert.equal(worker.posts.length, posted + 1)
})

test('answers that cannot be stored come back with the notes as a warning', async () => {
  const root = fixture()
  const replied = (key: string, value: any) => key === notesKey(root) && value.notes.some((n: any) => n.reply)
  const h = host(root, { 'agent.launch': { terminalId: 't-1' }, ...refusingStorage(replied) })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  answerFile(root, sent.review, added.id, 'verdict: confirmed\n\nDone.')
  const listed = (await worker.request('notes.list', { root })) as any
  assert.equal(listed.notes.length, 1)
  assert.equal(listed.notes[0].reply, undefined)
  assert.equal(typeof listed.warning, 'string')
  assert.match(listed.warning, /262144/)
})

test('a delete the store refuses says why', async () => {
  const root = fixture()
  let refuse = false
  const worker = await mountWorker(main, { host: host(root, refusingStorage(() => refuse)) })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  refuse = true
  const answer = (await worker.request('notes.delete', { root, ids: [added.id] })) as any
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /262144/)
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
  const posted = worker.posts.length
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  assert.equal(sent.ok, true)
  // Posted once, when the notes are marked and the agent started.
  assert.deepEqual(worker.posts.slice(posted), [{ event: 'notes.changed', payload: { root } }])
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
  const [stored] = ((await worker.request('notes.list', { root })) as any).notes
  assert.equal(stored.sentAt, undefined)
  assert.equal(stored.review, undefined)
  assert.deepEqual(readdirSync(join(root, '.orca-git-log')), [])
})

test('a sent mark that cannot be saved starts no agent and leaves no folder', async () => {
  const root = fixture()
  const marked = (key: string, value: any) => key === notesKey(root) && value.notes.some((n: any) => n.sentAt !== undefined)
  const h = host(root, { 'agent.launch': { terminalId: 't-1' }, ...refusingStorage(marked) })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  assert.equal(sent.ok, false)
  assert.match(sent.reason, /262144/)
  assert.equal(h.callsOf('agent.launch').length, 0)
  assert.deepEqual(readdirSync(join(root, '.orca-git-log')), [])
  assert.equal(((await worker.request('notes.list', { root })) as any).notes[0].sentAt, undefined)
})

test('one send at a time per repository', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const send = () => worker.request('notes.send', { root, ids: [added.id], agent: 'claude' }) as Promise<any>
  const answers = await Promise.all([send(), send()])
  assert.equal(h.callsOf('agent.launch').length, 1)
  assert.deepEqual(answers.map((a) => a.ok).sort(), [false, true])
  assert.equal(answers.find((a) => !a.ok).reason, t('reviewBusy'))
})

test('an edit removes the folder of the review no note references any more', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: a } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const { note: b } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [a.id, b.id], agent: 'claude' })) as any
  assert.equal(((await worker.request('notes.update', { root, id: a.id, body: 'again' })) as any).ok, true)
  assert.equal(existsSync(reviewPaths(root, sent.review).dir), true)
  assert.equal(((await worker.request('notes.update', { root, id: b.id, body: 'again' })) as any).ok, true)
  assert.equal(existsSync(reviewPaths(root, sent.review).dir), false)
})

test('nothing to send, a bad agent name', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  assert.equal(((await worker.request('notes.send', { root, ids: [], agent: 'claude' })) as any).ok, false)
  const bad = (await worker.request('notes.send', { root, ids: [added.id], agent: '--help' })) as any
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, t('reviewBadAgent', { agent: '--help' }))
  assert.equal(h.callsOf('agent.launch').length, 0)
})

test('the review skills go into the notes file and the prompt points at them', async () => {
  const root = fixture()
  writeFileSync(join(root, 'rules.md'), '# rules')
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  assert.equal(((await worker.request('skills.set', { root, skills: ['rules.md'] })) as any).ok, true)
  const send = async () => {
    const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
    const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
    assert.equal(sent.ok, true)
    const calls = h.callsOf('agent.launch') as { prompt: string }[]
    return { text: readFileSync(reviewPaths(root, sent.review).notes, 'utf8'), prompt: calls[calls.length - 1].prompt }
  }
  const first = await send()
  assert.ok(first.text.includes('Review skills to use first, in this order (each is a file, or a folder with a SKILL.md):'))
  assert.ok(first.text.split('\n').includes(`1. ${join(root, 'rules.md')}`))
  // At the top: before the first note.
  assert.ok(first.text.indexOf('Review skills to use first') < first.text.indexOf('## Note '))
  assert.ok(first.prompt.includes('Use the review skills listed at the top of'))
  assert.equal(first.prompt.includes('rules.md'), false)
  rmSync(join(root, 'rules.md'))
  const second = await send()
  assert.equal(second.text.includes('Review skills'), false)
  assert.ok(second.prompt.includes("Use this project's own review skills and rules first"))
  assert.deepEqual(worker.refusals, [])
})

test('skills that cannot be read leave the send to go without them', async () => {
  const root = fixture()
  const data: Record<string, unknown> = {}
  const storage = refusingStorage(() => false, data)
  const read = storage['storage.get'] as (input: { key: string }) => unknown
  const h = host(root, {
    'agent.launch': { terminalId: 't-1' },
    ...storage,
    'storage.get': (input: { key: string }) => {
      if (input.key.startsWith('skills:')) throw hostError('action_failed', 'storage is gone')
      return read(input)
    }
  })
  const worker = await mountWorker(main, { host: h })
  const { note: added } = (await worker.request('notes.add', { root, draft: draft() })) as any
  const sent = (await worker.request('notes.send', { root, ids: [added.id], agent: 'claude' })) as any
  assert.equal(sent.ok, true)
  assert.equal(readFileSync(reviewPaths(root, sent.review).notes, 'utf8').includes('Review skills'), false)
  assert.ok(worker.logs.some((line) => line.includes('review skills not read') && line.includes('storage is gone')))
})
