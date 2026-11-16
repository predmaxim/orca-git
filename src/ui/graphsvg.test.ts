import assert from 'node:assert/strict'
import { test } from 'node:test'
import { graphSvg, LANE_WIDTH, NARROW_LANE_WIDTH, type GraphRow } from './graph.ts'

const row: GraphRow = { lane: 1, color: 0, through: [{ lane: 2, color: 1 }], incoming: [], outgoing: [], width: 3 }

test('a narrow log draws the lanes closer together', () => {
  assert.ok(NARROW_LANE_WIDTH < LANE_WIDTH)
  assert.match(graphSvg(row), new RegExp(`width="${3 * LANE_WIDTH}"`))
  const narrow = graphSvg(row, { laneWidth: NARROW_LANE_WIDTH })
  assert.match(narrow, new RegExp(`width="${3 * NARROW_LANE_WIDTH}"`))
  // The node and the line through lane 2 sit in the middle of their narrow lanes.
  assert.match(narrow, new RegExp(`cx="${1.5 * NARROW_LANE_WIDTH}"`))
  assert.match(narrow, new RegExp(`M${2.5 * NARROW_LANE_WIDTH} 0L${2.5 * NARROW_LANE_WIDTH} `))
})
