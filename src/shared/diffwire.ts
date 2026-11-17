import type { DiffHunk, DiffLine, FileDiff } from './protocol.ts'

/**
 * A hunk as the worker sends it: its lines in one string, each its kind character and its text, joined by LF. Orca refuses
 * a worker's answer of more than 10 000 objects whatever its size, and an object per line passes that at 10 000 lines.
 */
export interface WireHunk {
  oldStart: number
  newStart: number
  section: string
  text: string
}

export type WireDiff = Omit<FileDiff, 'hunks'> & { hunks: WireHunk[] }

/** The diff as the worker answers it: a line never holds an LF, git splits on it. */
export const toWire = (diff: FileDiff): WireDiff => ({
  ...diff,
  hunks: diff.hunks.map(({ lines, ...hunk }) => ({ ...hunk, text: lines.map((line) => line.kind + line.text).join('\n') }))
})

/** The diff as the frame shows it: the line numbers count on from each hunk's start. */
export function fromWire(wire: WireDiff): FileDiff {
  return {
    ...wire,
    hunks: wire.hunks.map(({ text, ...hunk }): DiffHunk => {
      let old = hunk.oldStart
      let next = hunk.newStart
      const lines = (text ? text.split('\n') : []).map((raw): DiffLine => {
        const kind = raw[0] as DiffLine['kind']
        const line = raw.slice(1)
        if (kind === '-') return { kind, text: line, old: old++ }
        if (kind === '+') return { kind, text: line, new: next++ }
        return { kind: ' ', text: line, old: old++, new: next++ }
      })
      return { ...hunk, lines }
    })
  }
}
