import type { ChangeKind } from './diffmodel.ts'
import { h } from './dom.ts'

/** A mark of the map: the rows from `from` to `to` (inclusive). */
export interface OverviewMark { from: HTMLElement; to: HTMLElement; kind: ChangeKind | 'note' | 'note-resolved'; title: string }

/** Where a mark of the content from `top` to `bottom` goes in a strip `height` high for content `total` high: scaled, at least `min` high, whole inside the strip. */
export function stripSpan(top: number, bottom: number, total: number, height: number, min: number): { top: number; height: number } {
  if (total <= 0) return { top: 0, height: min }
  const scale = height / total
  const size = Math.max(min, (bottom - top) * scale)
  return { top: Math.max(0, Math.min(top * scale, height - size)), height: size }
}

/** The map of what `body` shows: a strip of marks, to be put next to `body`; a click on a mark scrolls its start to 40 px below the top, as F7 does. */
export function mountOverview(body: HTMLElement): { el: HTMLElement; set(marks: OverviewMark[]): void; dispose(): void } {
  // Screen readers go by F7 and the Notes list instead.
  const el = h('div', { class: 'diff-overview', 'aria-hidden': 'true', hidden: true })
  let marks: OverviewMark[] = []
  let frame = 0
  /** A y of the window as a distance from the top of `body`'s content, whatever it is scrolled to. */
  const at = (y: number) => y - body.getBoundingClientRect().top + body.scrollTop

  function draw(): void {
    frame = 0
    const total = body.scrollHeight
    const height = el.clientHeight
    el.replaceChildren(
      ...marks.map((mark) => {
        const span = stripSpan(at(mark.from.getBoundingClientRect().top), at(mark.to.getBoundingClientRect().bottom), total, height, mark.kind.startsWith('note') ? 3 : 2)
        return h('div', {
          class: `ov-${mark.kind}`,
          title: mark.title,
          style: `top: ${span.top}px; height: ${span.height}px`,
          onclick: () => (body.scrollTop = at(mark.from.getBoundingClientRect().top) - 40)
        })
      })
    )
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  // Wrapped lines, opened cards, loaded images and Orca's font move the rows: the map follows, once a frame.
  const observer = new ResizeObserver(schedule)

  return {
    el,
    /** The marks of what `body` shows now, the notes last so they draw over the changes; none hides the strip. */
    set(next) {
      marks = next
      el.hidden = !next.length
      observer.disconnect()
      if (!next.length) {
        el.replaceChildren()
        return
      }
      observer.observe(body)
      const lines = body.querySelector('.diff-lines')
      if (lines) observer.observe(lines)
      schedule()
    },
    dispose() {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }
}
