// Images of review messages in the Diff tab: sent to the worker in parts, read back into blob: URLs kept for the tab's life,
// drawn as thumbnails, and one at a time over the tab.
import { t } from '../shared/i18n.ts'
import { MAX_IMAGE_BYTES } from '../shared/notes.ts'
import type { NoteImage } from '../shared/protocol.ts'
import { api, errorMessage } from './api.ts'
import { h, icon } from './dom.ts'
import { sizeText } from './format.ts'
import { closePopups } from './menu.ts'
import { fromBase64, toBase64, uploadParts } from './notemodel.ts'

/** The type of a stored image, by the extension of its id. */
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** The blob: URL of each image read, by id: one for the tab's life. */
const urls = new Map<string, Promise<string>>()
/** Closes the image shown over the tab. */
let closeShown: (() => void) | null = null

/** Sends a pasted or picked file to the worker in parts. */
export async function uploadImage(root: string, file: Blob, name: string): Promise<{ ok: true; image: NoteImage } | { ok: false; reason: string }> {
  // The worker would say so only after 5 MiB of parts.
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: t('imageBig') }
  const parts = uploadParts(file.size)
  // An empty file is no image.
  if (!parts.length) return { ok: false, reason: t('imageKind') }
  const upload = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    for (const [index, [at, length]] of parts.entries()) {
      const data = toBase64(new Uint8Array(await file.slice(at, at + length).arrayBuffer()))
      const result = await api.imagesPut(root, upload, index, index === parts.length - 1, data, name)
      if (!result.ok) return result
      if (result.image) return { ok: true, image: result.image }
    }
  } catch (caught) {
    return { ok: false, reason: errorMessage(caught) }
  }
  return { ok: false, reason: t('imageUpload') }
}

/** Reads the image `id` from the worker, up to 600000 bytes a call, into a blob: URL; rejects when there is no such image. */
async function read(root: string, id: string): Promise<string> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let have = 0
  let total = 1
  while (have < total) {
    const part = await api.imagesGet(root, id, have)
    const bytes = fromBase64(part.data)
    if (!bytes.length) throw new Error(`no image ${id}`)
    parts.push(bytes)
    have += bytes.length
    total = part.total
  }
  return URL.createObjectURL(new Blob(parts, { type: MIME[id.slice(id.lastIndexOf('.') + 1)] ?? '' }))
}

/** A blob: URL of the image, read from the worker in parts and kept for the tab's life; a failed read is not kept, so the next drawing tries again. */
export function imageUrl(root: string, id: string): Promise<string> {
  let url = urls.get(id)
  if (!url) {
    const reading = read(root, id)
    reading.catch(() => {
      if (urls.get(id) === reading) urls.delete(id)
    })
    urls.set(id, reading)
    url = reading
  }
  return url
}

/** An image as a button that opens it: a box with its name while it loads, its name as text when it cannot be read. */
export function thumbnail(root: string, image: NoteImage): HTMLButtonElement {
  // showImage finds a thumbnail drawn anew by this label.
  const button = h('button', { class: 'd-image', 'aria-label': t('imageOpen', { name: image.name }), onclick: () => showImage(root, image) }, image.name)
  const failed = () => {
    button.className = 'd-image failed'
    button.replaceChildren(image.name)
  }
  imageUrl(root, image.id).then((src) => {
    button.className = 'd-image loaded'
    button.replaceChildren(h('img', { src, alt: image.name, title: image.name, onerror: failed }))
  }, failed)
  return button
}

/** Opens the image over the tab; Esc or a press outside closes it. */
export function showImage(root: string, image: NoteImage): void {
  closeShown?.()
  const back = document.activeElement as HTMLElement | null
  // One Esc must not close a menu or popover and the image at once.
  closePopups()
  const label = t('imageOpen', { name: image.name })
  const picture = h('img', { alt: image.name, title: image.name })
  const close = h('button', { class: 'tool', title: t('imageClose'), 'aria-label': t('imageClose'), onclick: () => finish() }, icon('close'))
  const layer = h(
    'div',
    {
      class: 'overlay image-view',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': image.name,
      // The press's own focus change would land on the layer just removed and take the focus off the thumbnail.
      onmousedown: (event: MouseEvent) => {
        event.preventDefault()
        if (event.target !== picture) finish()
      }
    },
    close,
    h('figure', null, picture, h('figcaption', null, h('span', null, image.name), h('span', { class: 'muted' }, sizeText(image.bytes))))
  )
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    finish()
  }
  const finish = () => {
    if (closeShown !== finish) return
    closeShown = null
    layer.remove()
    document.removeEventListener('keydown', onKey, true)
    // A redraw meanwhile drew the thumbnail anew: the focus goes to the one of this image drawn now.
    const heir = back?.isConnected ? back : Array.from(document.querySelectorAll<HTMLElement>('button.d-image')).find((el) => el.getAttribute('aria-label') === label)
    heir?.focus({ preventScroll: true })
  }
  closeShown = finish
  imageUrl(root, image.id).then(
    (src) => (picture.src = src),
    () => picture.replaceWith(h('span', null, image.name))
  )
  document.addEventListener('keydown', onKey, true)
  document.body.append(layer)
  close.focus()
}

/** Closes the image shown and revokes the URLs; the next drawing reads the images again. */
export function disposeImages(): void {
  closeShown?.()
  for (const url of urls.values()) url.then((src) => URL.revokeObjectURL(src), () => undefined)
  urls.clear()
}
