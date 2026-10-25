/**
 * Decoding, sampling, and frame-extraction tests.
 *
 * The load-bearing claim here is that a returned frame really is the frame it
 * says it is. A plausible-looking implementation that returned frame 0 eight
 * times would pass any test that only counted images, so these tests measure a
 * per-frame visual marker: every fixture draws a bar whose length encodes the
 * frame index, and the tests assert that bar length follows the reported order.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  DEFAULT_MAX_FRAMES,
  ZERO_DELAY_SUBSTITUTE_MS,
  declaresTransparency,
  planFrames,
  probeAnimation,
  renderFrames,
  sniffAnimatedPng,
} from '../lib/animation.js'
import { sharpOrSkip } from './helpers/sharp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(HERE, 'fixtures', name)
const load = (name) => readFile(fixture(name))

/**
 * Right edge, in pixels, of the fixture's orange index bar.
 * Every fixture frame draws this bar with a width proportional to its index, so
 * it is a per-frame identity that survives decoding, resizing, and re-encoding.
 * @returns the bar's right edge x coordinate.
 */
async function barRightEdge(sharp, pngBytes) {
  const { data, info } = await sharp(pngBytes).raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  let rightmost = -1
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * channels
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = channels > 3 ? data[i + 3] : 255
      if (a > 200 && r > 200 && g > 80 && g < 175 && b < 110 && x > rightmost) rightmost = x
    }
  }
  return rightmost
}

/** Whether any pixel in the image is not fully opaque. */
async function hasPartialAlpha(sharp, pngBytes) {
  const { data, info } = await sharp(pngBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let i = 3; i < data.length; i += info.channels) if (data[i] < 255) return true
  return false
}

test('probeAnimation reads frame count, delays, and duration from a GIF', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('moving-8f.gif'))
  assert.equal(animation.format, 'gif')
  assert.equal(animation.mediaType, 'image/gif')
  assert.equal(animation.width, 240)
  assert.equal(animation.height, 160)
  assert.equal(animation.frameCount, 8)
  assert.deepEqual(animation.delaysMs, [80, 80, 80, 80, 80, 80, 80, 80])
  assert.deepEqual(animation.startsMs, [0, 80, 160, 240, 320, 400, 480, 560])
  assert.equal(animation.durationMs, 640)
  assert.equal(animation.zeroDelays, false)
  assert.equal(animation.missingDelays, false)
  assert.equal(animation.loop, 0)
})

test('probeAnimation reads an animated WebP the same way', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('moving.webp'))
  assert.equal(animation.format, 'webp')
  assert.equal(animation.mediaType, 'image/webp')
  assert.equal(animation.frameCount, 8)
  assert.equal(animation.durationMs, 640)
})

test('probeAnimation refuses an APNG instead of silently returning its first frame', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('anim.apng.png')
  // Precondition: the file really is an APNG, and sharp really cannot see that.
  assert.equal(sniffAnimatedPng(bytes), true)
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.pages ?? 1, 1, 'libvips reports an APNG as a single-frame PNG')

  await assert.rejects(
    () => probeAnimation(sharp, bytes),
    /animated PNG \(APNG\)/,
  )
})

test('probeAnimation reports a single-frame GIF rather than failing', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('still.gif'))
  assert.equal(animation.frameCount, 1)
})

test('probeAnimation rejects bytes that are not an image', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('not-an-image.txt')
  await assert.rejects(() => probeAnimation(sharp, bytes), /could not be decoded/)
})

test('sniffAnimatedPng accepts still PNGs and rejects non-PNG bytes', async () => {
  assert.equal(sniffAnimatedPng(await load('still.png')), false)
  assert.equal(sniffAnimatedPng(await load('moving-8f.gif')), false)
  assert.equal(sniffAnimatedPng(new Uint8Array([1, 2, 3])), false)
})

test('declaresTransparency reads the container header, which hasAlpha cannot substitute for', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  assert.equal(declaresTransparency('gif', await load('moving-8f.gif')), false)
  assert.equal(declaresTransparency('gif', await load('transparent.gif')), true)
  assert.equal(declaresTransparency('webp', await load('moving.webp')), true, 'Pillow sets the VP8X alpha flag')
  assert.equal(declaresTransparency('png', new Uint8Array(0)), undefined, 'unknown formats are reported as unknown')

  // Why the header and not `metadata().hasAlpha`: sharp's `hasAlpha` for a GIF
  // tracks the decoded channel layout, not the file's declaration. Two GIFs
  // written by the same encoder with identical graphic-control flags — the
  // transparent-colour flag clear in both — report opposite values purely
  // because one carries a 128-entry colour table and the other a 4-entry one.
  // Reporting "transparency was flattened" off that signal would be noise.
  assert.equal((await sharp(await load('transparent.gif')).metadata()).hasAlpha, true)
})

test('even sampling spreads across time and yields distinct frame indices', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('moving-8f.gif'))
  const plan = planFrames(animation, { maxFrames: 4 })
  assert.deepEqual(plan.map((f) => f.index), [0, 2, 5, 7])
  assert.deepEqual(plan.map((f) => f.timeMs), [0, 160, 400, 560])
  assert.deepEqual(plan.map((f) => f.position), [1, 2, 3, 4])
})

test('a budget at or above the frame count returns every frame', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('uneven-delays.gif'))
  const plan = planFrames(animation, { maxFrames: DEFAULT_MAX_FRAMES })
  assert.deepEqual(plan.map((f) => f.index), [0, 1, 2, 3])
})

test('sampling an uneven animation reports only the frames that occupy the timeline', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  // Delays are 500/50/50/400 ms: frames 1 and 2 flash past. Asking for two
  // samples must return the two long frames, not an arbitrary pair.
  const animation = await probeAnimation(sharp, await load('uneven-delays.gif'))
  assert.deepEqual(animation.delaysMs, [500, 50, 50, 400])
  assert.equal(animation.durationMs, 1000)

  const plan = planFrames(animation, { maxFrames: 2 })
  assert.deepEqual(plan.map((f) => f.index), [0, 3])
})

test('explicit frame indices are honoured in the given order, and out-of-range ones are refused', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('moving-8f.gif'))
  const plan = planFrames(animation, { frames: [7, 0, 3, 3] })
  assert.deepEqual(plan.map((f) => f.index), [7, 0, 3], 'duplicates collapse, order is preserved')

  assert.throws(() => planFrames(animation, { frames: [8] }), /out of range/)
  assert.throws(() => planFrames(animation, { frames: [-1] }), /out of range/)
  assert.throws(() => planFrames(animation, { frames: [] }), /at least one frame/)
})

test('max_frames is validated rather than silently coerced', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const animation = await probeAnimation(sharp, await load('moving-8f.gif'))
  assert.throws(() => planFrames(animation, { maxFrames: 0 }), /positive integer/)
  assert.throws(() => planFrames(animation, { maxFrames: 2.5 }), /positive integer/)
})

test('extracted frames are the frames that were asked for, in order', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('moving-8f.gif')
  const animation = await probeAnimation(sharp, bytes)
  const plan = planFrames(animation, { maxFrames: 4 })
  const rendered = await renderFrames(sharp, bytes, plan, {})

  assert.equal(rendered.length, 4)
  for (const frame of rendered) {
    assert.equal(frame.width, 240)
    assert.equal(frame.height, 160)
    assert.ok(frame.data.byteLength > 0)
  }

  // The index bar grows with the frame index, so a strictly increasing sequence
  // proves both that the frames differ and that they arrived in the right order.
  const edges = []
  for (const frame of rendered) edges.push(await barRightEdge(sharp, frame.data))
  for (let i = 1; i < edges.length; i += 1) {
    assert.ok(
      edges[i] > edges[i - 1],
      `frame ${i} (bar edge ${edges[i]}) should sit further right than frame ${i - 1} (${edges[i - 1]}); edges were ${edges.join(', ')}`,
    )
  }
})

test('start and end frames are genuinely different pictures', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('moving-8f.gif')
  const animation = await probeAnimation(sharp, bytes)
  const plan = planFrames(animation, { frames: [0, 7] })
  const [first, last] = await renderFrames(sharp, bytes, plan, {})
  assert.notEqual(Buffer.from(first.data).toString('base64'), Buffer.from(last.data).toString('base64'))
})

test('max_edge caps the long edge and never enlarges', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('big-60f.gif')
  const animation = await probeAnimation(sharp, bytes)
  const plan = planFrames(animation, { maxFrames: 2 })

  const small = await renderFrames(sharp, bytes, plan, { maxEdge: 128 })
  for (const frame of small) {
    assert.equal(frame.width, 128)
    assert.equal(frame.height, Math.round((400 * 128) / 600))
  }

  const untouched = await renderFrames(sharp, bytes, plan, { maxEdge: 2048 })
  for (const frame of untouched) {
    assert.equal(frame.width, 600)
    assert.equal(frame.height, 400)
  }

  await assert.rejects(async () => renderFrames(sharp, bytes, plan, { maxEdge: 8 }), /max_edge/)
})

test('a transparent GIF is flattened onto white by default and can keep alpha on request', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('transparent.gif')
  const animation = await probeAnimation(sharp, bytes)
  assert.equal(animation.usesTransparency, true)

  const plan = planFrames(animation, { maxFrames: 2 })
  const flattened = await renderFrames(sharp, bytes, plan, { background: 'white' })
  for (const frame of flattened) {
    assert.equal(await hasPartialAlpha(sharp, frame.data), false, 'flattened frames must be fully opaque')
  }

  const kept = await renderFrames(sharp, bytes, plan, { background: 'keep' })
  assert.equal(await hasPartialAlpha(sharp, kept[0].data), true, 'kept frames must retain transparency')
})

test('a zero frame delay is treated as 100 ms instead of collapsing the duration', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  // Sharp reports a zero delay for this file; the animation would otherwise have
  // a zero duration and every sampling target would clamp to frame 0.
  const animation = await probeAnimation(sharp, await load('zero-delay.gif'))
  assert.equal(animation.zeroDelays, true)
  assert.ok(animation.delaysMs.every((d) => d === ZERO_DELAY_SUBSTITUTE_MS))
  assert.equal(animation.durationMs, ZERO_DELAY_SUBSTITUTE_MS * animation.frameCount)

  const plan = planFrames(animation, { maxFrames: 4 })
  assert.ok(new Set(plan.map((f) => f.index)).size > 1, 'sampling must not collapse onto one frame')
})

test('renderFrames observes cancellation between frames', async (t) => {
  const sharp = sharpOrSkip(t)
  if (sharp === undefined) return

  const bytes = await load('big-60f.gif')
  const animation = await probeAnimation(sharp, bytes)
  const controller = new AbortController()
  controller.abort(new Error('cancelled by test'))

  await assert.rejects(
    () => renderFrames(sharp, bytes, planFrames(animation, { maxFrames: 4 }), {}, controller.signal),
    /cancelled by test/,
  )
})
