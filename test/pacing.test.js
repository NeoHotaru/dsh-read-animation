/**
 * The pacing decision, tested without an image library.
 *
 * The properties that matter are the safety ones: on a clip where every gap is
 * doing something, the content strategy must return the even picks untouched; it
 * must never move the first or last frame; and it must never crowd a neighbour.
 * Those are the promises that keep this from being a gamble on material we cannot
 * benchmark.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUSY,
  STILL,
  analyzePacing,
  changeBetween,
  chooseFrames,
  evenIndices,
  probePlan,
} from '../lib/pacing.js'

/** A flat greyscale frame at one level, so a change is exactly the level difference. */
const frame = (level, size = 64) => Uint8Array.from({ length: size }, () => level)

/** A decoded-frames map from `[index, level]` pairs. */
const decoded = (pairs) => new Map(pairs.map(([index, level]) => [index, frame(level)]))

test('change between two frames is the mean pixel difference', () => {
  assert.equal(changeBetween(frame(0), frame(0)), 0)
  assert.equal(changeBetween(frame(0), frame(10)), 10)
  assert.equal(changeBetween(frame(200), frame(0)), 200)
})

test('change between different lengths is safe', () => {
  assert.equal(changeBetween(frame(0, 10), frame(10, 4)), 10)
  assert.equal(changeBetween(frame(0, 0), frame(10, 0)), 0)
})

test('even sampling includes both ends and never repeats one', () => {
  assert.deepEqual(evenIndices(56, 8), [0, 8, 16, 24, 31, 39, 47, 55])
  assert.deepEqual(evenIndices(10, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(evenIndices(3, 8), [0, 1, 2])
  assert.deepEqual(evenIndices(1, 8), [0])
  assert.deepEqual(evenIndices(56, 1), [0])
})

test('the thresholds sit between a hold and real action', () => {
  // Measured on real material: holds 0.0, a slow intro 1-6, action 12-31.
  assert.ok(STILL < 3)
  assert.ok(BUSY >= 8 && BUSY < 12)
})

test('a gap is judged from its middle, not only from its ends', () => {
  // Both ends are identical, so comparing only the ends would call this a hold.
  // The middle shows the animation moved and came back, which is exactly the
  // "something happened in between" case that a caption must not hide.
  const chosen = [0, 10]
  const report = analyzePacing(chosen, decoded([[0, 0], [5, 40], [10, 0]]), 11)
  assert.equal(report.gaps.length, 1)
  assert.equal(report.gaps[0].change, 40)
  assert.equal(report.gaps[0].busy, true)
  assert.equal(report.gaps[0].still, false)
})

test('a genuinely held gap is reported as still', () => {
  const report = analyzePacing([0, 10], decoded([[0, 0], [5, 0], [10, 0]]), 11)
  assert.equal(report.gaps[0].change, 0)
  assert.equal(report.gaps[0].still, true)
  assert.equal(report.stillGaps.length, 1)
  assert.equal(report.busyGaps.length, 0)
})

test('the report names the busiest gap', () => {
  const report = analyzePacing(
    [0, 10, 20, 30],
    decoded([[0, 0], [5, 0], [10, 0], [15, 3], [20, 3], [25, 60], [30, 60]]),
    31,
  )
  assert.equal(report.busiest.from, 20)
  assert.equal(report.busiest.to, 30)
  // The middle probe is what sees this: the two ends of that gap differ by 57 and
  // the probe sits between them, so the gap reads as very busy.
  assert.equal(report.busiest.change, 57)
})

test('the even strategy ignores pacing entirely', () => {
  const pacing = analyzePacing([0, 10, 20], decoded([[0, 0], [10, 0], [20, 60], [15, 60]]), 21)
  assert.deepEqual(chooseFrames(21, 3, pacing, 'even').indices, [0, 10, 20])
  assert.deepEqual(chooseFrames(21, 3, pacing, 'even').moved, [])
})

test('content leaves the picks alone when every gap is doing something', () => {
  // The safety property: nothing to gain means nothing changes, so this cannot be
  // worse than the sampler it replaces on material where even sampling is right.
  const chosen = [0, 10, 20, 30]
  const pacing = analyzePacing(
    chosen,
    decoded([[0, 0], [5, 15], [10, 30], [15, 45], [20, 60], [25, 75], [30, 90]]),
    31,
  )
  assert.equal(pacing.stillGaps.length, 0)
  const picked = chooseFrames(31, 4, pacing, 'content')
  assert.deepEqual(picked.indices, chosen)
  assert.deepEqual(picked.moved, [])
})

/**
 * Every gap in the result must be one that was measured, or part of one, or a
 * merge of gaps that were each measured still.
 *
 * This is the property that keeps the content strategy from being a gamble: it may
 * compress a stretch it has *proved* is a hold, and it may never invent a stretch
 * nobody looked at. A gap that is a *sub-interval* of a measured one is fine — the
 * strategy only ever inserts into a gap it has already probed, which hides less
 * than the original did. The first implementation failed this on a padded clip,
 * leaving a 49-frame gap that had never been probed.
 */
function assertNoUnmeasuredGaps(pacing, indices) {
  const measured = new Map(pacing.gaps.map((gap) => [`${gap.from}:${gap.to}`, gap]))
  for (let at = 1; at < indices.length; at += 1) {
    const from = indices[at - 1]
    const to = indices[at]
    if (measured.has(`${from}:${to}`)) continue
    if (pacing.gaps.some((gap) => gap.from <= from && to <= gap.to)) continue
    const between = pacing.gaps.filter((gap) => gap.from >= from && gap.to <= to)
    assert.ok(between.length > 0, `gap ${from}:${to} was never measured`)
    assert.ok(
      between.every((gap) => gap.still),
      `gap ${from}:${to} is neither measured nor a merge of still gaps: ${JSON.stringify(between)}`,
    )
  }
}

test('content moves a tile only when both of its sides are still', () => {
  const chosen = [0, 10, 20, 30, 40, 50]
  // 0-20 held, then fast movement.
  const pacing = analyzePacing(
    chosen,
    decoded([
      [0, 0], [5, 0], [10, 0], [15, 0], [20, 0],
      [25, 20], [30, 40], [35, 60], [40, 80], [45, 100], [50, 120],
    ]),
    51,
  )
  const picked = chooseFrames(51, 6, pacing, 'content')

  assert.ok(picked.moved.length > 0, 'a held stretch should free a tile')
  assert.equal(picked.indices.length, chosen.length, 'the tile count never changes')
  assert.equal(picked.indices[0], 0, 'the first frame is never moved')
  assert.equal(picked.indices[picked.indices.length - 1], 50, 'the last frame is never moved')
  for (const move of picked.moved) {
    assert.ok(move.stillChange < STILL, `moved out of a stretch that was not still (${move.stillChange})`)
    assert.ok(move.gapChange > BUSY, `moved into a gap that was not busy (${move.gapChange})`)
  }
  assertNoUnmeasuredGaps(pacing, picked.indices)
})

test('a dead hold at each end is collapsed to one frame, not two', () => {
  // The clip that exposed the hole: a hold, the story, a hold. The story has to
  // actually vary, or the gaps inside it measure as still and prove nothing.
  const chosen = evenIndices(136, 8)
  const level = (at) => (at <= 45 ? 0 : at >= 90 ? 140 : Math.round(((at - 45) * 140) / 45))
  const pacing = analyzePacing(
    chosen,
    decoded(probePlan(chosen, 136).map((at) => [at, level(at)])),
    136,
  )
  assert.equal(pacing.stillGaps.length, 4, 'both holds are still, on both sides')

  const picked = chooseFrames(136, 8, pacing, 'content')
  assert.equal(picked.indices.length, 8)
  assert.equal(picked.indices[0], 0)
  assert.equal(picked.indices[7], 135)
  assert.ok(picked.moved.length >= 1, 'the freed budget goes into the story')
  assertNoUnmeasuredGaps(pacing, picked.indices)
})

test('content never places two frames closer than two apart', () => {
  const chosen = [0, 10, 20, 30, 40, 50, 60, 70]
  const pacing = analyzePacing(
    chosen,
    decoded([
      [0, 0], [10, 0], [20, 0], [30, 0], [40, 0],
      [45, 30], [50, 60], [55, 90], [60, 120], [65, 150], [70, 180],
    ]),
    71,
  )
  const picked = chooseFrames(71, 8, pacing, 'content')
  for (let at = 1; at < picked.indices.length; at += 1) {
    assert.ok(picked.indices[at] - picked.indices[at - 1] >= 2, `frames ${picked.indices} are crowded`)
  }
})

test('content without a pacing report falls back to even', () => {
  const picked = chooseFrames(21, 3, undefined, 'content')
  assert.deepEqual(picked.indices, [0, 10, 20])
  assert.deepEqual(picked.moved, [])
})

test('content on too few frames to have a middle falls back to even', () => {
  const pacing = analyzePacing([0, 10], decoded([[0, 0], [5, 0], [10, 0]]), 11)
  assert.deepEqual(chooseFrames(11, 2, pacing, 'content').indices, [0, 10])
})

test('the probe plan covers every gap middle and both ends', () => {
  assert.deepEqual(probePlan([0, 10, 20], 21), [0, 5, 10, 15, 20])
  // The 24-31 gap has no whole middle, so the probe lands on 28; the last sample
  // is already the final frame, so nothing is added after it.
  assert.deepEqual(
    probePlan([0, 8, 16, 24, 31, 39, 47, 55], 56),
    [0, 4, 8, 12, 16, 20, 24, 28, 31, 35, 39, 43, 47, 51, 55],
  )
})

test('the probe plan adds the frames just outside the sampled range', () => {
  const plan = probePlan([10, 20], 41)
  assert.ok(plan.includes(9), 'the frame before the first sample')
  assert.ok(plan.includes(21), 'the frame after the last sample')
  assert.ok(plan.every((index) => index >= 0 && index < 41))
})

test('the probe plan is bounded by the frame count, not the animation length', () => {
  // This is what makes probing affordable: a 300-frame clip costs the same as a
  // 60-frame one, because only the gaps are visited.
  const short = probePlan(evenIndices(60, 8), 60)
  const long = probePlan(evenIndices(300, 8), 300)
  assert.equal(short.length, long.length)
  assert.ok(long.length <= 2 * 8 + 1)
})
