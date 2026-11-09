// Commit graph lanes: a branch keeps its lane and color; merges and forks draw
// diagonals between the node and neighbouring lanes. Lanes never shift sideways, so a line
// passing through a row is one vertical segment.

export interface GraphInput {
  hash: string
  parents: string[]
}

export interface Segment {
  lane: number
  color: number
}

export interface GraphRow {
  lane: number
  color: number
  /** Lanes passing straight through the row. */
  through: Segment[]
  /** Lanes ending at the node, from the top edge (the node's children). */
  incoming: Segment[]
  /** Lanes leaving the node towards the bottom edge (its parents). */
  outgoing: Segment[]
  /** Number of lanes used by this row. */
  width: number
}

export const COLORS = 8

export function computeGraph(rows: GraphInput[], linear = false): GraphRow[] {
  if (linear) {
    return rows.map((_, i) => ({
      lane: 0,
      color: 0,
      through: [],
      incoming: i > 0 ? [{ lane: 0, color: 0 }] : [],
      outgoing: i < rows.length - 1 ? [{ lane: 0, color: 0 }] : [],
      width: 1
    }))
  }
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  const free = (avoid = -1) => {
    const index = lanes.findIndex((lane, i) => lane === null && i !== avoid)
    return index < 0 ? Math.max(lanes.length, avoid + 1) : index
  }
  const out: GraphRow[] = []
  for (const row of rows) {
    const incomingLanes: number[] = []
    lanes.forEach((hash, i) => hash === row.hash && incomingLanes.push(i))
    let lane = incomingLanes.length ? incomingLanes[0] : free()
    if (!incomingLanes.length) {
      lanes[lane] = null
      colors[lane] = nextColor++ % COLORS
    }
    const color = colors[lane]
    const incoming = incomingLanes.map((i) => ({ lane: i, color: colors[i] }))
    const through: Segment[] = []
    lanes.forEach((hash, i) => hash !== null && hash !== row.hash && through.push({ lane: i, color: colors[i] }))
    for (const i of incomingLanes) lanes[i] = null

    const outgoing: Segment[] = []
    row.parents.forEach((parent, index) => {
      // The first parent continues the node's lane even when another lane already waits for it:
      // both lines then converge on the fork commit.
      const existing = index === 0 && lanes[lane] === null ? -1 : lanes.indexOf(parent)
      if (existing >= 0) {
        outgoing.push({ lane: existing, color: colors[existing] })
        return
      }
      const target = index === 0 && lanes[lane] === null ? lane : free(lane)
      lanes[target] = parent
      if (target !== lane) colors[target] = nextColor++ % COLORS
      else colors[target] = color
      outgoing.push({ lane: target, color: colors[target] })
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(lane + 1, ...through.map((s) => s.lane + 1), ...incoming.map((s) => s.lane + 1), ...outgoing.map((s) => s.lane + 1))
    out.push({ lane, color, through, incoming, outgoing, width })
  }
  return out
}

export const LANE_WIDTH = 14
export const ROW_HEIGHT = 24
/** A narrow commits column shows author and date under the message. */
export const TWO_LINE_ROW_HEIGHT = 40

const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2

/** One row of the graph as SVG markup; `head` draws the node as a ring. */
export function graphSvg(row: GraphRow, options: { head?: boolean; dim?: boolean; merge?: boolean; height?: number } = {}): string {
  const h = options.height ?? ROW_HEIGHT
  const mid = h / 2
  const width = row.width * LANE_WIDTH
  const parts: string[] = []
  const line = (x1: number, y1: number, x2: number, y2: number, color: number) =>
    parts.push(`<path d="M${x1} ${y1}L${x2} ${y2}" class="edge c${color}"/>`)
  for (const s of row.through) line(x(s.lane), 0, x(s.lane), h, s.color)
  for (const s of row.incoming) line(x(s.lane), 0, x(row.lane), mid, s.color)
  for (const s of row.outgoing) line(x(row.lane), mid, x(s.lane), h, s.color)
  const r = options.merge ? 3 : 3.6
  parts.push(
    options.head
      ? `<circle cx="${x(row.lane)}" cy="${mid}" r="4.2" class="node head c${row.color}"/>`
      : `<circle cx="${x(row.lane)}" cy="${mid}" r="${r}" class="node c${row.color}"/>`
  )
  return `<svg class="graph${options.dim ? ' dim' : ''}" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join('')}</svg>`
}
