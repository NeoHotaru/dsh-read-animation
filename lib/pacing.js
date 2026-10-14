/**
 * Where an animation's change actually is, and which frames to show because of it.
 *
 * ### Why this exists
 *
 * Sampling a fixed number of frames at equal intervals answers "what does this
 * animation look like", which is not the same question as "how does it go". The
 * budget is spread over *time*, while an animation's content lives in *change*: a
 * long hold at either end gets the same share as the moment something happens.
 *
 * Measured on a real 56-frame clip: even sampling spent three of its eight tiles
 * on the opening where the frame-to-frame change is 1-6 (of 255), and never
 * sampled the single largest change in the clip (frame 53, change 31.4). Padded to
 * 136 frames with held ends — what a trimmed screen recording looks like — five of
 * the eight tiles were pixel-identical to their neighbour.
 *
 * ### What it deliberately does not do
 *
 * It does not replace coverage with content. The literature on keyframe selection
 * is split: content-aware selection wins on information-dense questions and
 * uniform sampling keeps an edge on temporal continuity, which is exactly what a
 * story is made of. So the equal-interval skeleton is kept, and a tile is moved
 * **only when the stretch around it is measured to be still** — meaning that tile
 * and its neighbour show the same picture and nothing is lost by moving it. When
 * nothing qualifies, this returns the even picks unchanged.
 *
 * The module is pure: the caller decodes the frames (including the in-between
 * probes) and this decides. That keeps the decision testable without an image
 * library, and keeps the cost of probing a caller concern.
 *
 * @module dsh-read-animation/pacing
 */

/**
 * Mean absolute pixel difference between two frames, on the 0-255 scale.
 *
 * Measured on real material: held frames score 0.0, a slow intro scores 1-6, and
 * action scores 12-31. The two thresholds below come from that spread rather than
 * from taste.
 */
export function changeBetween(a, b) {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let total = 0
  for (let at = 0; at < length; at += 1) total += Math.abs(a[at] - b[at])
  return total / length
}

/** Below this, two frames are the same picture for any practical purpose. */
export const STILL = 2

/** Above this, something is happening between the two frames. */
export const BUSY = 8

/**
 * Describe the change in every gap between consecutive chosen frames.
 *
 * A gap is probed once, in the middle, and the two halves are compared: a gap
 * whose middle differs from both ends is a gap where something moved.
 *
 * @param chosen - the frame indices that will be shown, in order.
 * @param decoded - `Map<index, Uint8Array>` of greyscale pixels, holding at least
 *   the chosen frames and whatever {@link probePlan} asked for in between.
 * @param frameCount - frames in the whole animation.
 * @returns per-gap facts, plus which gaps are still and which are busy.
 */
export function analyzePacing(chosen, decoded, frameCount) {
  const at = (index) => decoded.get(index)

  const gaps = []
  for (let slot = 1; slot < chosen.length; slot += 1) {
    const from = chosen[slot - 1]
    const to = chosen[slot]
    const middle = Math.round((from + to) / 2)
    const left = at(from)
    const right = at(to)
    if (left === undefined || right === undefined) continue

    const between = middle > from && middle < to ? at(middle) : undefined
    const change =
      between === undefined
        ? changeBetween(left, right)
        : Math.max(changeBetween(left, between), changeBetween(between, right))

    gaps.push({ from, to, frames: to - from, change, still: change < STILL, busy: change > BUSY })
  }

  const busiest = gaps.reduce((best, gap) => (best === undefined || gap.change > best.change ? gap : best), undefined)

  // How much of each end is still, which is what tells a reader where the story
  // is rather than where the file happens to start.
  const firstMoving = gaps.findIndex((gap) => !gap.still)
  const lastMoving = gaps.length - 1 - [...gaps].reverse().findIndex((gap) => !gap.still)

  return {
    gaps,
    busiest,
    stillGaps: gaps.filter((gap) => gap.still),
    busyGaps: gaps.filter((gap) => gap.busy),
    stillUntil: firstMoving > 0 ? gaps[firstMoving].from : undefined,
    stillFrom: lastMoving >= 0 && lastMoving < gaps.length - 1 ? gaps[lastMoving].to : undefined,
    frameCount,
  }
}

/**
 * The frames to show, under the chosen strategy.
 *
 * `content` removes a tile only when **both** gaps beside it were measured still:
 * removing it then merges two still stretches into one that is still by the same
 * measurement, so nothing unmeasured is ever created. The freed tiles go into the
 * busiest gaps, at the probe that measured them.
 *
 * The stricter rule is not caution for its own sake. The first version removed a
 * tile when *either* neighbour was still, and on a padded clip that produced a
 * 49-frame gap that had never been probed — a coverage hole presented as a
 * saving. The constraint that matters is not "no long gaps" but "no *unmeasured*
 * gaps": a sixty-frame stretch that was measured still is a correctly compressed
 * hold, and losing it costs nothing.
 *
 * @param frameCount - frames in the animation.
 * @param count - how many frames to choose.
 * @param pacing - the report from {@link analyzePacing}, or undefined when the
 *   caller did not probe (in which case only `even` is possible).
 * @param strategy - `'even'` keeps equal intervals; `'content'` moves only the
 *   tiles whose surroundings are measured still.
 * @returns `{ indices, moved }`, where `moved` explains each relocation.
 */
export function chooseFrames(frameCount, count, pacing, strategy) {
  const even = evenIndices(frameCount, count)
  if (strategy !== 'content' || pacing === undefined || even.length < 3) {
    return { indices: even, moved: [] }
  }

  const measured = new Map(pacing.gaps.map((gap) => [`${gap.from}:${gap.to}`, gap]))

  /** The status of the gap between two kept frames, or undefined if nobody measured it. */
  const gapBetween = (from, to) => {
    const exact = measured.get(`${from}:${to}`)
    if (exact !== undefined) return exact
    const between = pacing.gaps.filter((gap) => gap.from >= from && gap.to <= to)
    if (between.length === 0 || between.some((gap) => !gap.still)) return undefined
    return { from, to, frames: to - from, change: Math.max(...between.map((gap) => gap.change)), still: true, busy: false }
  }

  // Remove the tiles that sit inside a still stretch, at both ends of it. The
  // first and last frames are never removed: they are the animation's state.
  const kept = [...even]
  const freed = []
  for (let at = even.length - 2; at >= 1; at -= 1) {
    const before = measured.get(`${even[at - 1]}:${even[at]}`)
    const after = measured.get(`${even[at]}:${even[at + 1]}`)
    if (before?.still === true && after?.still === true) {
      freed.push({ index: even[at], stillChange: Math.max(before.change, after.change) })
      kept.splice(kept.indexOf(even[at]), 1)
    }
  }

  const moved = []
  for (const freedTile of freed) {
    // The busiest gap that still has room for a frame in the middle of it.
    const target = kept
      .map((from, at) => (at + 1 < kept.length ? gapBetween(from, kept[at + 1]) : undefined))
      .map((gap, at) => ({ gap, at }))
      .filter(({ gap }) => gap?.busy === true && gap.frames > 2)
      .sort((a, b) => b.gap.change - a.gap.change)[0]
    if (target === undefined) break

    const insert = Math.round((target.gap.from + target.gap.to) / 2)
    const crowded = kept.some((index) => Math.abs(index - insert) < 2)
    if (crowded || insert <= 0 || insert >= frameCount - 1) break

    kept.splice(kept.findIndex((index) => index > insert), 0, insert)
    moved.push({ from: freedTile.index, to: insert, gapChange: target.gap.change, stillChange: freedTile.stillChange })
  }

  return { indices: kept, moved }
}

/**
 * Equal intervals, first and last included.
 *
 * This is the sampler the plugin has always used, kept as the default and as the
 * skeleton the content strategy starts from.
 */
export function evenIndices(frameCount, count) {
  if (frameCount <= 1 || count <= 1) return [0]
  if (count >= frameCount) return [...Array(frameCount).keys()]
  const picks = []
  for (let slot = 0; slot < count; slot += 1) picks.push(Math.round((slot * (frameCount - 1)) / (count - 1)))
  return [...new Set(picks)]
}

/**
 * Where to probe for the change in each gap, without decoding every frame.
 *
 * One probe per gap, plus the two ends of the animation so the "still" stretches
 * can be described. That is `count + 1` extra decodes regardless of how long the
 * animation is, against `frameCount` for a full change profile — which is what
 * makes this affordable on a 300-frame clip.
 *
 * @param indices - the chosen frames, in order.
 * @param frameCount - frames in the animation.
 * @returns `{ samples, probes }` as index lists, deduplicated and in order.
 */
export function probePlan(indices, frameCount) {
  const wanted = new Set(indices)
  for (let at = 1; at < indices.length; at += 1) {
    const middle = Math.round((indices[at - 1] + indices[at]) / 2)
    if (middle > indices[at - 1] && middle < indices[at]) wanted.add(middle)
  }
  // The frames just before the first sample and after the last, so an opening or
  // closing hold is visible rather than inferred.
  if (indices[0] > 0) wanted.add(indices[0] - 1)
  if (indices[indices.length - 1] < frameCount - 1) wanted.add(indices[indices.length - 1] + 1)
  return [...wanted].filter((index) => index >= 0 && index < frameCount).sort((a, b) => a - b)
}
