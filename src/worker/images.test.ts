import { existsSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mountWorker, test } from 'orca/testing'
import { IMAGE_ID, MAX_IMAGE_BYTES } from '../shared/notes.ts'
import { t } from '../shared/i18n.ts'
import type { NoteMessage } from '../shared/protocol.ts'
import { answerImages, imageKind, probes, putImage, readImage, storeImage, sweepImages } from './images.ts'
import * as main from './main.ts'
import { noteKey, notesKey } from './notes.ts'
import { notesFile, readAnswers, reviewPaths } from './review.ts'
import { draft, fixture, host } from './testkit.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
const scratch = (): string => mkdtempSync(join(tmpdir(), 'git-log-images-'))
const gone = (...paths: string[]): void => paths.forEach((p) => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('the kind comes from the first bytes', () => {
  assert.equal(imageKind(PNG), 'png')
  assert.equal(imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
  assert.equal(imageKind(new TextEncoder().encode('GIF89a')), 'gif')
  assert.equal(imageKind(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(imageKind(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ')), null)
  assert.equal(imageKind(new TextEncoder().encode('just text')), null)
  assert.equal(imageKind(new Uint8Array()), null)
})

test('the same bytes are stored once, under the hash of their content', () => {
  const root = scratch()
  try {
    const first = storeImage(root, PNG, 'a/b/shot.png')
    const again = storeImage(root, PNG, '\u0007c:\\x\\other.png')
    assert.ok(first.ok && again.ok)
    assert.match(first.image.id, IMAGE_ID)
    assert.equal(first.image.id, again.image.id)
    assert.equal(first.image.bytes, PNG.length)
    assert.equal(first.image.name, 'shot.png')
    assert.equal(again.image.name, 'other.png')
    assert.equal(storeImage(root, PNG, '///').ok && (storeImage(root, PNG, '///') as any).image.name, first.image.id)
    assert.deepEqual(readdirSync(join(root, '.orca-git-log', 'images')), [first.image.id])
  } finally {
    gone(root)
  }
})

test('what is not an image, or is too large, is refused and nothing is written', () => {
  const root = scratch()
  try {
    assert.deepEqual(storeImage(root, new TextEncoder().encode('text'), 'a.png'), { ok: false, reason: t('imageKind') })
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    big.set(PNG)
    assert.deepEqual(storeImage(root, big, 'big.png'), { ok: false, reason: t('imageBig') })
    assert.equal(existsSync(join(root, '.orca-git-log')), false)
    const limit = new Uint8Array(MAX_IMAGE_BYTES)
    limit.set(PNG)
    assert.equal(storeImage(root, limit, 'limit.png').ok, true)
  } finally {
    gone(root)
  }
})

test('a link in place of the folders is refused', () => {
  const root = scratch()
  const outside = scratch()
  try {
    symlinkSync(outside, join(root, '.orca-git-log'))
    assert.equal(storeImage(root, PNG, 'a.png').ok, false)
    assert.deepEqual(readdirSync(outside), [])
    rmSync(join(root, '.orca-git-log'))
    mkdirSync(join(root, '.orca-git-log'))
    symlinkSync(outside, join(root, '.orca-git-log', 'images'))
    assert.equal(storeImage(root, PNG, 'a.png').ok, false)
    assert.deepEqual(readdirSync(outside), [])
    // A valid image in the linked folder is not read through it either.
    const id = `${'0'.repeat(12)}.png`
    writeFileSync(join(outside, id), PNG)
    assert.equal(readImage(root, id, 0, 100), null)
    rmSync(join(root, '.orca-git-log', 'images'))
    mkdirSync(join(root, '.orca-git-log', 'images'))
    symlinkSync(join(outside, id), join(root, '.orca-git-log', 'images', id))
    assert.equal(readImage(root, id, 0, 100), null)
  } finally {
    gone(root, outside)
  }
})

test('a name already taken by other bytes is refused and left as it was', () => {
  const root = scratch()
  try {
    const first = storeImage(root, PNG, 'a.png')
    assert.ok(first.ok)
    const file = join(root, '.orca-git-log', 'images', first.image.id)
    writeFileSync(file, PNG.subarray(0, 5))
    assert.deepEqual(storeImage(root, PNG, 'a.png'), { ok: false, reason: t('imageFailed', { error: 'EEXIST' }) })
    assert.deepEqual(new Uint8Array(readFileSync(file)), PNG.subarray(0, 5))
    // Same length, other content.
    writeFileSync(file, new Uint8Array(PNG.length).fill(9))
    assert.equal(storeImage(root, PNG, 'a.png').ok, false)
    assert.deepEqual(readdirSync(join(root, '.orca-git-log', 'images')), [first.image.id])
  } finally {
    gone(root)
  }
})

test('uploads: at most 4 unfinished, one older than 60 seconds is dropped, another root is refused', () => {
  const root = scratch()
  const part = Buffer.alloc(45000).toString('base64')
  const input = (upload: string, index: number, last = false, data = part) => ({ upload, index, last, data, name: 'x' })
  try {
    const ids = ['111111111111', '222222222222', '333333333333', '444444444444']
    for (const id of ids) assert.equal(putImage(root, input(id, 0), 1000).ok, true)
    assert.equal(putImage(root, input('555555555555', 0), 1000).ok, false)
    // One of the four goes on; a fifth waits for room.
    assert.equal(putImage(root, input(ids[0], 1), 2000).ok, true)
    // After 60 seconds without a part the upload is gone.
    assert.equal(putImage(root, input(ids[1], 1), 1000 + 60001).ok, false)
    assert.equal(putImage(root, input('555555555555', 0), 1000 + 60001).ok, true)
    // Another root cannot continue an upload.
    assert.equal(putImage(root + 'x', input('555555555555', 1, true, 'AAAA'), 1000 + 60002).ok, false)
    assert.equal(putImage(root, input('555555555555', 1, true, 'AAAA'), 1000 + 60003).ok, false)
    for (const id of ids) putImage(root, input(id, 9), 1000 + 200000)
  } finally {
    gone(root)
  }
})

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

test('an image goes in parts and comes back in parts', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const bytes = new Uint8Array(1_000_000)
    bytes.set(PNG)
    bytes.fill(7, PNG.length)
    // Parts of 45000 bytes (a multiple of 3): each is whole base64, 60000 characters.
    const upload = 'abcdef012345'
    const count = Math.ceil(bytes.length / 45000)
    let image: any
    for (let i = 0; i < count; i++) {
      const part = (await worker.request('images.put', { root, upload, index: i, last: i === count - 1, data: base64(bytes.subarray(i * 45000, (i + 1) * 45000)), name: 'dir/shot.png' })) as any
      assert.equal(part.ok, true)
      image = part.image
    }
    assert.ok(image)
    assert.equal(image.bytes, bytes.length)
    assert.equal(image.name, 'shot.png')
    const parts: Buffer[] = []
    let offset = 0
    for (;;) {
      const got = (await worker.request('images.get', { root, id: image.id, offset })) as any
      assert.equal(got.total, bytes.length)
      const data = Buffer.from(got.data, 'base64')
      if (!data.length) break
      parts.push(data)
      offset += data.length
    }
    assert.equal(parts.length, 2)
    assert.ok(Buffer.concat(parts).equals(bytes))
    assert.deepEqual(await worker.request('images.get', { root, id: '../../etc/passwd', offset: 0 }), { data: '', total: 0 })
    // Out of order: the part is refused and so is the next one of that upload.
    const other = '0123456789ab'
    const full = base64(Buffer.alloc(45000))
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 0, last: false, data: full, name: 'x' })) as any).ok, true)
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 2, last: false, data: full, name: 'x' })) as any).ok, false)
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 1, last: true, data: 'AAAA', name: 'x' })) as any).ok, false)
    // A short middle part, and a truthy `last` that is not true, finish nothing.
    const short = 'dddddddddddd'
    assert.equal(((await worker.request('images.put', { root, upload: short, index: 0, last: false, data: full.slice(0, 40000), name: 'x' })) as any).ok, false)
    const loose = 'eeeeeeeeeeee'
    const goesOn = (await worker.request('images.put', { root, upload: loose, index: 0, last: 1 as any, data: full, name: 'x' })) as any
    assert.deepEqual(goesOn, { ok: true })
    assert.equal(((await worker.request('images.put', { root, upload: loose, index: 1, last: true, data: 'AAAA', name: 'x' })) as any).reason, t('imageKind'))
    // Not base64, too long and over the size limit.
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 0, last: true, data: '***!', name: 'x' })) as any).ok, false)
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 0, last: true, data: 'A'.repeat(60004), name: 'x' })) as any).ok, false)
    const huge = Buffer.alloc(45000)
    const bigUpload = 'bbbbbbbbbbbb'
    let refused: any
    for (let i = 0; i < 200 && !refused; i++) {
      const part = (await worker.request('images.put', { root, upload: bigUpload, index: i, last: false, data: huge.toString('base64'), name: 'x' })) as any
      if (!part.ok) refused = part
    }
    assert.equal(refused.reason, t('imageBig'))
    assert.equal(worker.refusals.length, 0)
    await worker.deactivate()
  } finally {
    gone(root)
  }
})

test('the images folder is kept out of git status, and attach and browse read what the user names', async () => {
  const root = fixture()
  const outside = scratch()
  try {
    writeFileSync(join(outside, 'one.png'), PNG)
    writeFileSync(join(outside, 'note.txt'), 'text')
    mkdirSync(join(outside, 'sub'))
    symlinkSync(join(outside, 'one.png'), join(outside, 'link.jpg'))
    const worker = await mountWorker(main, { host: host(root) })
    assert.deepEqual(await worker.request('images.browse', { root, dir: outside }), { dirs: ['sub'], files: ['link.jpg', 'one.png'] })
    const attached = (await worker.request('images.attach', { root, path: join(outside, 'link.jpg') })) as any
    assert.equal(attached.ok, true)
    assert.equal(attached.image.name, 'link.jpg')
    assert.equal(((await worker.request('images.attach', { root, path: join(outside, 'note.txt') })) as any).reason, t('imageKind'))
    assert.equal(((await worker.request('images.attach', { root, path: join(outside, 'sub') })) as any).ok, false)
    assert.equal(((await worker.request('images.attach', { root, path: join(outside, 'none.png') })) as any).ok, false)
    assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').includes('.orca-git-log/'), true)
    await worker.deactivate()
  } finally {
    gone(root, outside)
  }
})

test('a message names only images that are stored, and the thread keeps their files while any message uses them', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const put = (await worker.request('images.put', { root, upload: 'aaaaaaaaaaaa', index: 0, last: true, data: base64(PNG), name: 'p.png' })) as any
    const image = put.image
    const file = join(root, '.orca-git-log', 'images', image.id)
    // The frame's numbers and name are not believed; a missing file or a bad id is refused.
    const lie = { id: image.id, name: 'a/../b\u0001.png', bytes: 1 }
    assert.equal(((await worker.request('notes.add', { root, draft: draft({ images: [{ id: '000000000000.png', name: 'x', bytes: 1 }] }) })) as any).ok, false)
    assert.equal(((await worker.request('notes.add', { root, draft: draft({ images: [{ id: '../x', name: 'x', bytes: 1 }] }) })) as any).ok, false)
    assert.equal(((await worker.request('notes.add', { root, draft: draft({ images: Array(6).fill(lie) }) })) as any).reason, t('imageMany'))
    const first = (await worker.request('notes.add', { root, draft: draft({ images: [lie] }) })) as any
    assert.deepEqual(first.note.messages[0].images, [{ id: image.id, name: 'b.png', bytes: PNG.length }])
    const second = (await worker.request('notes.add', { root, draft: draft({ images: [lie] }) })) as any
    const reply = (await worker.request('notes.reply', { root, id: second.note.id, body: 'more', images: [lie] })) as any
    assert.deepEqual(reply.note.messages[1].images, [{ id: image.id, name: 'b.png', bytes: PNG.length }])
    // The notes file lists the full path of each image under its message's header, at column 0.
    const paths = reviewPaths(root, 'bbbbbbbbbbbb')
    const text = notesFile([second.note, reply.note], paths)
    assert.ok(text.includes(`:\nImages: ${file}\n`))
    assert.equal(existsSync(file), true)
    assert.equal(((await worker.request('notes.remove', { root, id: first.note.id, message: first.note.messages[0].id })) as any).ok, true)
    assert.equal(existsSync(file), true)
    assert.equal(((await worker.request('notes.remove', { root, id: second.note.id, message: reply.note.messages[1].id })) as any).ok, true)
    assert.equal(existsSync(file), true)
    assert.equal(((await worker.request('notes.remove', { root, id: second.note.id, message: second.note.messages[0].id })) as any).ok, true)
    assert.equal(existsSync(file), false)
    // A thread deleted takes its images too, also with `all`.
    const again = (await worker.request('images.put', { root, upload: 'cccccccccccc', index: 0, last: true, data: base64(PNG), name: 'p.png' })) as any
    await worker.request('notes.add', { root, draft: draft({ images: [again.image] }) })
    assert.equal(existsSync(file), true)
    await worker.request('notes.delete', { root, all: true })
    assert.equal(existsSync(file), false)
    await worker.deactivate()
  } finally {
    gone(root)
  }
})

test('an answer attaches only regular files right inside its answers folder', () => {
  const root = scratch()
  const outside = scratch()
  try {
    const answers = join(root, '.orca-git-log', 'review-bbbbbbbbbbbb', 'answers')
    mkdirSync(join(answers, 'sub'), { recursive: true })
    writeFileSync(join(answers, 'a.png'), PNG)
    writeFileSync(join(answers, 'sub', 'b.png'), PNG)
    writeFileSync(join(outside, 'c.png'), PNG)
    symlinkSync(join(outside, 'c.png'), join(answers, 'c.png'))
    // A real image outside `answers`: only the path rule refuses it.
    writeFileSync(join(root, '.orca-git-log', 'review-bbbbbbbbbbbb', 'notes.md'), PNG)
    writeFileSync(join(root, 'above.png'), PNG)
    writeFileSync(join(answers, 'd.png'), 'plain text')
    const body = ['![a](a.png)', '![b](sub/b.png)', '![c](c.png)', '![n](../notes.md)', '![up](../../../above.png)', `![abs](${join(root, 'above.png')})`, '![d](d.png)', '![same](./a.png)'].join('\n')
    const images = answerImages(root, answers, body)
    assert.equal(images.length, 1)
    assert.equal(images[0].name, 'a.png')
    assert.deepEqual(answerImages(root, answers, body), images)
    assert.deepEqual(readdirSync(join(root, '.orca-git-log', 'images')), [images[0].id])
  } finally {
    gone(root, outside)
  }
})

test('the images of an answer go into the thread, and the same answer read again changes nothing', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root, { 'agent.launch': { terminalId: 't-1' } }) })
    const added = (await worker.request('notes.add', { root, draft: draft() })) as any
    const sent = (await worker.request('notes.send', { root, ids: [added.note.id], agent: 'claude' })) as any
    const { answers, notes } = reviewPaths(root, sent.review)
    // An answer written as the notes file tells: the picture next to the answer file, shown by its bare name.
    assert.ok(readFileSync(notes, 'utf8').includes('saved next to the answer file and shown as `![caption](file-name.png)` with the file\'s bare name'))
    writeFileSync(join(answers, 'a.png'), PNG)
    writeFileSync(join(answers, `${added.note.id}.md`), 'verdict: answered\nfixed: no\n\nLook: ![shot](a.png)')
    const read = async (): Promise<NoteMessage[]> => (((await worker.request('notes.list', { root })) as any).notes[0].messages as NoteMessage[])
    const [, reply] = await read()
    assert.equal(reply.images?.length, 1)
    assert.equal(reply.images?.[0].name, 'a.png')
    const posts = worker.posts.length
    assert.deepEqual((await read())[1], reply)
    assert.equal(worker.posts.length, posts)
    await worker.deactivate()
  } finally {
    gone(root)
  }
})

test('an answer repeating one image reads its file once, and one naming many files tries five', () => {
  const root = scratch()
  try {
    const answers = join(root, '.orca-git-log', 'review-bbbbbbbbbbbb', 'answers')
    mkdirSync(answers, { recursive: true })
    const big = new Uint8Array(MAX_IMAGE_BYTES)
    big.set(PNG)
    writeFileSync(join(answers, 'a.png'), big)
    probes.files = 0
    assert.equal(answerImages(root, answers, '![](a.png)\n'.repeat(800)).length, 1)
    assert.equal(probes.files, 1)
    for (let i = 0; i < 10; i++) writeFileSync(join(answers, `t${i}.png`), 'not an image '.repeat(1000))
    probes.files = 0
    assert.deepEqual(answerImages(root, answers, Array.from({ length: 10 }, (_, i) => `![](t${i}.png)`).join('\n')), [])
    assert.equal(probes.files, 5)
  } finally {
    gone(root)
  }
})

test('an answer body that would make the image search backtrack is read in linear time; a normal one gives the same images', () => {
  const root = scratch()
  try {
    const answers = join(root, '.orca-git-log', 'review-bbbbbbbbbbbb', 'answers')
    mkdirSync(answers, { recursive: true })
    for (const unit of ['![a](', '![a](<']) {
      const body = unit.repeat(Math.ceil(8000 / unit.length)).slice(0, 8000)
      const start = Date.now()
      assert.deepEqual(answerImages(root, answers, body), [])
      assert.ok(Date.now() - start < 500, `${unit}: ${Date.now() - start} ms`)
    }
    writeFileSync(join(answers, 'a.png'), PNG)
    for (const body of ['![shot](a.png)', '![shot](<a.png>)', '![shot]( a.png "title")']) assert.deepEqual(answerImages(root, answers, body).map((i) => i.name), ['a.png'], body)
  } finally {
    gone(root)
  }
})

test('storing bytes again makes their file new, so the sweep leaves it until its message is saved', () => {
  const root = scratch()
  try {
    const first = storeImage(root, PNG, 'a.png')
    assert.ok(first.ok)
    const file = join(root, '.orca-git-log', 'images', first.image.id)
    const longAgo = new Date(Date.now() - 25 * 3600 * 1000)
    utimesSync(file, longAgo, longAgo)
    assert.equal(storeImage(root, PNG, 'again.png').ok, true)
    sweepImages(root, [], Date.now())
    assert.equal(existsSync(file), true)
    // A time that cannot be set (Windows asks for write access to set it) does not fail the reuse.
    const refused = storeImage(root, PNG, 'third.png', () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) })
    assert.deepEqual(refused, { ok: true, image: { id: first.image.id, name: 'third.png', bytes: PNG.length } })
  } finally {
    gone(root)
  }
})

test('a pending root that is not the top level of a repository is skipped, and nothing under it is read, stored or removed', async () => {
  const root = fixture()
  const bad = scratch()
  try {
    const { body, ...anchor } = draft()
    const waiting = { ...anchor, id: 'aaaaaaaaaaaa', createdAt: 1, messages: [{ id: 'mmmmmmmmmmmm', author: 'user', body, at: 1, review: 'bbbbbbbbbbbb', sentAt: 1 }] }
    const { answers } = reviewPaths(bad, 'bbbbbbbbbbbb')
    mkdirSync(answers, { recursive: true })
    writeFileSync(join(answers, 'a.png'), PNG)
    writeFileSync(join(answers, 'aaaaaaaaaaaa.md'), 'verdict: answered\nfixed: no\n\n![a](a.png)')
    // An unused image a day old: a sweep would remove it.
    const images = join(bad, '.orca-git-log', 'images')
    mkdirSync(images)
    const old = join(images, 'cccccccccccc.png')
    writeFileSync(old, PNG)
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000)
    utimesSync(old, longAgo, longAgo)
    const h = host(root, {}, { [notesKey(bad)]: { root: bad, ids: [waiting.id] }, [noteKey(bad, waiting.id)]: waiting, pending: [bad] } as any)
    const worker = await mountWorker(main, { host: h, events: ['agent.status.changed'] })
    await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: 1 })
    assert.deepEqual(readdirSync(images), ['cccccccccccc.png'])
    assert.equal((h.data().storage[noteKey(bad, waiting.id)] as any).messages.length, 1)
    assert.ok(worker.logs.some((line) => line.includes(`answers not read for ${bad}`)))
    await worker.deactivate()
  } finally {
    gone(root, bad)
  }
})

test('an answers folder, or a folder above it, that is a link reads no answer and no image', async () => {
  const root = fixture()
  const outside = scratch()
  try {
    const worker = await mountWorker(main, { host: host(root, { 'agent.launch': { terminalId: 't-1' } }) })
    const added = (await worker.request('notes.add', { root, draft: draft() })) as any
    const sent = (await worker.request('notes.send', { root, ids: [added.note.id], agent: 'claude' })) as any
    const { answers, dir } = reviewPaths(root, sent.review)
    writeFileSync(join(outside, 'shot.png'), PNG)
    writeFileSync(join(outside, `${added.note.id}.md`), 'verdict: answered\nfixed: no\n\n![](shot.png)')
    rmSync(answers, { recursive: true })
    symlinkSync(outside, answers)
    assert.deepEqual(answerImages(root, answers, '![](shot.png)'), [])
    assert.equal(readAnswers(root, ((await worker.request('notes.list', { root })) as any).notes).size, 0)
    // The same with the review folder itself linked.
    rmSync(answers)
    const moved = join(outside, 'moved')
    mkdirSync(join(moved, 'answers'), { recursive: true })
    writeFileSync(join(moved, 'answers', 'shot.png'), PNG)
    writeFileSync(join(moved, 'answers', `${added.note.id}.md`), 'verdict: answered\nfixed: no\n\n![](shot.png)')
    rmSync(dir, { recursive: true })
    symlinkSync(moved, dir)
    assert.equal(readAnswers(root, ((await worker.request('notes.list', { root })) as any).notes).size, 0)
    assert.deepEqual(answerImages(root, join(dir, 'answers'), '![](shot.png)'), [])
    assert.equal(existsSync(join(root, '.orca-git-log', 'images')), false)
    await worker.deactivate()
  } finally {
    gone(root, outside)
  }
})

test('the image of an answer that is replaced goes, and an unused file older than a day is swept', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root, { 'agent.launch': { terminalId: 't-1' } }) })
    const added = (await worker.request('notes.add', { root, draft: draft() })) as any
    const sent = (await worker.request('notes.send', { root, ids: [added.note.id], agent: 'claude' })) as any
    const { answers } = reviewPaths(root, sent.review)
    const other = Uint8Array.from([...PNG, 9, 9])
    writeFileSync(join(answers, 'one.png'), PNG)
    writeFileSync(join(answers, 'two.png'), other)
    const answer = (name: string) => writeFileSync(join(answers, `${added.note.id}.md`), `verdict: answered\nfixed: no\n\n![](${name})`)
    const list = async (): Promise<any> => (await worker.request('notes.list', { root })) as any
    const images = join(root, '.orca-git-log', 'images')
    answer('one.png')
    const [, first] = (await list()).notes[0].messages
    assert.equal(existsSync(join(images, first.images[0].id)), true)
    answer('two.png')
    const [, second] = (await list()).notes[0].messages
    assert.notEqual(second.images[0].id, first.images[0].id)
    assert.equal(existsSync(join(images, first.images[0].id)), false)
    assert.equal(existsSync(join(images, second.images[0].id)), true)
    // Files nobody uses: one a day old goes with the next removal, a fresh one stays.
    const old = join(images, 'aaaaaaaaaaaa.png')
    const fresh = join(images, 'bbbbbbbbbbbb.png')
    writeFileSync(old, PNG)
    writeFileSync(fresh, PNG)
    const longAgo = new Date(Date.now() - 25 * 3600 * 1000)
    utimesSync(old, longAgo, longAgo)
    assert.equal(((await worker.request('notes.remove', { root, id: added.note.id, message: added.note.messages[0].id })) as any).ok, true)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(fresh), true)
    await worker.deactivate()
  } finally {
    gone(root)
  }
})

test('the sweep leaves what a message uses, what is not an image name and what is a link', () => {
  const root = scratch()
  const outside = scratch()
  try {
    const images = join(root, '.orca-git-log', 'images')
    mkdirSync(images, { recursive: true })
    const names = ['cccccccccccc.png', 'dddddddddddd.png', 'notes.txt']
    for (const name of names) writeFileSync(join(images, name), PNG)
    writeFileSync(join(outside, 'x.png'), PNG)
    symlinkSync(join(outside, 'x.png'), join(images, 'eeeeeeeeeeee.png'))
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000)
    for (const name of names) utimesSync(join(images, name), longAgo, longAgo)
    const used = { id: 'x', createdAt: 1, messages: [{ id: 'm', author: 'user', body: 'b', at: 1, images: [{ id: 'cccccccccccc.png', name: 'c', bytes: 1 }] }] } as any
    sweepImages(root, [used], Date.now())
    assert.deepEqual(readdirSync(images).sort(), ['cccccccccccc.png', 'eeeeeeeeeeee.png', 'notes.txt'])
  } finally {
    gone(root, outside)
  }
})
