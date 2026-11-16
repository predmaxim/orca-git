import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mountWorker, test } from 'orca/testing'
import { IMAGE_ID, MAX_IMAGE_BYTES } from '../shared/notes.ts'
import { t } from '../shared/i18n.ts'
import type { NoteMessage } from '../shared/protocol.ts'
import { answerImages, imageKind, storeImage } from './images.ts'
import * as main from './main.ts'
import { reviewPaths, notesFile } from './review.ts'
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
  } finally {
    gone(root, outside)
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
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 0, last: false, data: base64(PNG.subarray(0, 9)), name: 'x' })) as any).ok, true)
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 2, last: false, data: 'AAAA', name: 'x' })) as any).ok, false)
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 1, last: true, data: base64(PNG.subarray(9)), name: 'x' })) as any).ok, false)
    // Not base64, too long and over the size limit.
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 0, last: true, data: '***!', name: 'x' })) as any).ok, false)
    assert.equal(((await worker.request('images.put', { root, upload: other, index: 0, last: true, data: 'A'.repeat(64004), name: 'x' })) as any).ok, false)
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
    // The notes file lists the full path of each image under its message.
    const paths = reviewPaths(root, 'bbbbbbbbbbbb')
    const text = notesFile([second.note, reply.note], paths)
    assert.ok(text.includes(`    Images: ${file}\n`))
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
    writeFileSync(join(root, '.orca-git-log', 'review-bbbbbbbbbbbb', 'notes.md'), 'notes')
    writeFileSync(join(answers, 'd.png'), 'plain text')
    const body = ['![a](a.png)', '![b](sub/b.png)', '![c](c.png)', '![n](../notes.md)', '![d](d.png)', '![same](./a.png)'].join('\n')
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
    const { answers } = reviewPaths(root, sent.review)
    writeFileSync(join(answers, 'shot.png'), PNG)
    writeFileSync(join(answers, `${added.note.id}.md`), 'verdict: answered\nfixed: no\n\nLook: ![shot](shot.png)')
    const read = async (): Promise<NoteMessage[]> => (((await worker.request('notes.list', { root })) as any).notes[0].messages as NoteMessage[])
    const [, reply] = await read()
    assert.equal(reply.images?.length, 1)
    assert.equal(reply.images?.[0].name, 'shot.png')
    const posts = worker.posts.length
    assert.deepEqual((await read())[1], reply)
    assert.equal(worker.posts.length, posts)
    await worker.deactivate()
  } finally {
    gone(root)
  }
})
