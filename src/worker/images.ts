// The images of review messages: files in <root>/.orca-git-log/images/, named by the hash of their content.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { t } from '../shared/i18n.ts'
import { IMAGE_ID, MAX_IMAGE_BYTES, MAX_IMAGES } from '../shared/notes.ts'
import type { NoteImage, ReviewNote } from '../shared/protocol.ts'
import { isFolder } from './review.ts'

const FOLDER = '.orca-git-log'
const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants
const failure = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** <root>/.orca-git-log/images */
export const imagesDir = (root: string): string => join(root, FOLDER, 'images')

/** png, jpg, gif or webp by the first bytes; null for anything else. */
export function imageKind(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const at = (offset: number, ...sign: number[]): boolean => sign.every((byte, i) => bytes[offset + i] === byte)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  return null
}

/** The last part of a path, without control characters, at most 200 characters; empty gives `fallback`. */
function cleanName(name: unknown, fallback: string): string {
  let clean = String(name ?? '').split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '').trim().slice(0, 200)
  // The cut must not leave half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(clean)) clean = clean.slice(0, -1).trim()
  return clean || fallback
}

/** Makes the folder when it is missing (not recursive); whether a real folder is there. */
function ensureFolder(path: string): boolean {
  try {
    mkdirSync(path)
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  }
  return isFolder(path)
}

/** Stores the bytes as .orca-git-log/images/<12 hex of sha256>.<kind>; the same bytes give the same file. */
export function storeImage(root: string, bytes: Uint8Array, name: string): { ok: true; image: NoteImage } | { ok: false; reason: string } {
  const kind = imageKind(bytes)
  if (!kind) return failure(t('imageKind'))
  if (bytes.length > MAX_IMAGE_BYTES) return failure(t('imageBig'))
  const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${kind}`
  const dir = imagesDir(root)
  try {
    for (const folder of [dirname(dir), dir]) if (!ensureFolder(folder)) return failure(t('reviewDirTaken', { path: folder }))
    const file = join(dir, id)
    let fd: number
    try {
      // wx: never follows a link and never replaces a file.
      fd = openSync(file, 'wx')
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      const stored = lstatSync(file)
      return stored.isFile() && stored.size === bytes.length ? { ok: true, image: { id, name: cleanName(name, id), bytes: bytes.length } } : failure(t('reviewDirTaken', { path: file }))
    }
    try {
      writeFileSync(fd, bytes)
    } catch (error) {
      closeSync(fd)
      fd = -1
      // Only the file this call made: a half-written one would be reused as the image.
      try {
        unlinkSync(file)
      } catch {
        // Already gone.
      }
      throw error
    } finally {
      if (fd >= 0) closeSync(fd)
    }
    return { ok: true, image: { id, name: cleanName(name, id), bytes: bytes.length } }
  } catch (error: any) {
    return failure(t('imageFailed', { error: error?.code ?? String(error) }))
  }
}

/** Runs `use` on a regular file opened for reading; null when it cannot be opened, is not a regular file, or `use` fails. Without `follow` a link is refused and a FIFO does not block. */
function withFile<T>(path: string, follow: boolean, use: (fd: number, size: number) => T): T | null {
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NONBLOCK | (follow ? 0 : O_NOFOLLOW))
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    return stat.isFile() ? use(fd, stat.size) : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function readBytes(fd: number, offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  return bytes.subarray(0, readSync(fd, bytes, 0, length, offset))
}

/** `length` bytes from `offset` of the stored image `id`, and its size; null when the id or the file is not right. */
export function readImage(root: string, id: string, offset: number, length: number): { data: Uint8Array; total: number } | null {
  if (typeof id !== 'string' || !IMAGE_ID.test(id) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) return null
  if (!isFolder(join(root, FOLDER)) || !isFolder(imagesDir(root))) return null
  return withFile(join(imagesDir(root), id), false, (fd, size) => (size > MAX_IMAGE_BYTES ? null : { data: readBytes(fd, offset, Math.min(length, Math.max(0, size - offset))), total: size }))
}

/** The images of a message the frame sent, as stored: only `id` is believed, and its file must be there; `bytes` come from the file, `name` is cleaned. */
export function checkImages(root: string, input: unknown): { ok: true; images: NoteImage[] } | { ok: false; reason: string } {
  if (input === undefined || input === null) return { ok: true, images: [] }
  if (!Array.isArray(input)) return failure(t('noteInvalid'))
  if (input.length > MAX_IMAGES) return failure(t('imageMany'))
  const images: NoteImage[] = []
  for (const item of input) {
    const id = item?.id
    const found = typeof id === 'string' && IMAGE_ID.test(id) ? readImage(root, id, 0, 0) : null
    if (!found) return failure(t('imageMissing', { path: String(id).slice(0, 64) }))
    if (!images.some((i) => i.id === id)) images.push({ id, name: cleanName(item.name, id), bytes: found.total })
  }
  return { ok: true, images }
}

/** Stores the image file the user names (links are followed, as a file dialog does); its size is checked before it is read. */
export function attachImage(root: string, path: string): { ok: true; image: NoteImage } | { ok: false; reason: string } {
  const read = withFile(path, true, (fd, size) => (size > MAX_IMAGE_BYTES ? ('big' as const) : readBytes(fd, 0, size)))
  if (read === null) return failure(t('imageMissing', { path }))
  return read === 'big' ? failure(t('imageBig')) : storeImage(root, read, basename(path))
}

/** Removes the files of `ids` that no note of `notes` uses. Best effort: never throws. */
export function dropImages(root: string, ids: string[], notes: ReviewNote[]): void {
  try {
    const used = new Set(notes.flatMap((n) => n.messages.flatMap((m) => (m.images ?? []).map((i) => i.id))))
    if (!isFolder(join(root, FOLDER)) || !isFolder(imagesDir(root))) return
    for (const id of new Set(ids)) {
      if (typeof id !== 'string' || !IMAGE_ID.test(id) || used.has(id)) continue
      const file = join(imagesDir(root), id)
      try {
        if (lstatSync(file).isFile()) unlinkSync(file)
      } catch {
        // The file stays; the caller has nothing to do about it.
      }
    }
  } catch {
    // Nothing to remove.
  }
}

/** The images an answer names: `![caption](file)` with a regular file right inside `answers`; each stored, at most MAX_IMAGES. */
export function answerImages(root: string, answers: string, body: string): NoteImage[] {
  const images: NoteImage[] = []
  const folder = resolve(answers)
  for (const [, address] of body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    if (images.length >= MAX_IMAGES) break
    const file = resolve(folder, address)
    if (dirname(file) !== folder) continue
    try {
      if (!lstatSync(file).isFile()) continue
    } catch {
      continue
    }
    const bytes = withFile(file, false, (fd, size) => (size > MAX_IMAGE_BYTES ? null : readBytes(fd, 0, size)))
    const stored = bytes && storeImage(root, bytes, basename(file))
    if (stored?.ok && !images.some((i) => i.id === stored.image.id)) images.push(stored.image)
  }
  return images
}

/** Parts of an image on its way in: base64 chunks by upload id, kept in memory for seconds. */
const uploads = new Map<string, { root: string; chunks: Uint8Array[]; size: number; next: number; at: number }>()
const MAX_UPLOADS = 4
const UPLOAD_TTL = 60000
const UPLOAD_ID = /^[0-9a-f]{12}$/
const MAX_CHUNK = 64000
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The next part of an upload (`index` from 0, in order); on `last` the whole is stored. A part that breaks the rules drops its upload. */
export function putImage(root: string, input: { upload: unknown; index: unknown; last: unknown; data: unknown; name: unknown }, now = Date.now()): { ok: true; image?: NoteImage } | { ok: false; reason: string } {
  for (const [id, upload] of uploads) if (now - upload.at > UPLOAD_TTL) uploads.delete(id)
  const { upload: id, index, data } = input
  const broken = failure(t('imageUpload'))
  if (typeof id !== 'string' || !UPLOAD_ID.test(id) || !Number.isInteger(index) || (index as number) < 0 || typeof data !== 'string') return broken
  const current = uploads.get(id)
  if (index === 0 && !current && uploads.size >= MAX_UPLOADS) return broken
  const upload = index === 0 ? { root, chunks: [] as Uint8Array[], size: 0, next: 0, at: now } : current
  if (!upload || upload.root !== root || upload.next !== index || data.length > MAX_CHUNK || data.length % 4 !== 0 || !BASE64.test(data)) {
    uploads.delete(id)
    return broken
  }
  const chunk = Buffer.from(data, 'base64')
  if (upload.size + chunk.length > MAX_IMAGE_BYTES) {
    uploads.delete(id)
    return failure(t('imageBig'))
  }
  upload.chunks.push(chunk)
  upload.size += chunk.length
  upload.next++
  upload.at = now
  if (!input.last) {
    uploads.set(id, upload)
    return { ok: true }
  }
  uploads.delete(id)
  return storeImage(root, Buffer.concat(upload.chunks), String(input.name ?? ''))
}
