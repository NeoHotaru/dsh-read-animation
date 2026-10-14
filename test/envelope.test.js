/**
 * The model-facing text is the only place the model can learn that the attached
 * images are consecutive moments of one animation, so its claims are worth
 * pinning: which frames were sampled, how long the animation runs, and what was
 * quietly changed during decoding.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatAnimationHeader, formatFrameCaption, frameAttachmentName } from '../lib/envelope.js'

/** A canonical value shaped exactly like the tool's output schema. */
function value(overrides = {}) {
  return {
    path: 'C:\\work\\dance.gif',
    animation: {
      mediaType: 'image/gif',
      width: 480,
      height: 270,
      frameCount: 24,
      durationMs: 1200,
      sampling: 'even',
      minDelayMs: 50,
      maxDelayMs: 50,
      loopsForever: true,
      zeroDelaysNormalized: false,
      missingDelays: false,
      transparencyFlattened: false,
      sampledFrames: [
        { position: 1, index: 0, timeMs: 0, delayMs: 50, image: {} },
        { position: 2, index: 9, timeMs: 450, delayMs: 50, image: {} },
        { position: 3, index: 23, timeMs: 1150, delayMs: 50, image: {} },
      ],
      ...overrides,
    },
  }
}

test('the header names the format, size, frame count, duration, and looping', () => {
  const header = formatAnimationHeader(value())
  assert.match(header, /image\/gif animation, 480x270 px, 24 frames, 1200 ms total/)
  assert.match(header, /~20 fps/)
  assert.match(header, /loops forever/)
  assert.match(header, /<path>C:\\work\\dance\.gif<\/path>/)
})

test('the header states that the frames are one animation in time order', () => {
  const header = formatAnimationHeader(value())
  assert.match(header, /consecutive moments of the SAME animation, in time order/)
  assert.match(header, /each is preceded by its frame index and start time/)
})

test('the header lists exactly which frames were sampled and warns about the gaps', () => {
  const header = formatAnimationHeader(value())
  assert.match(header, /Only frames 0, 9, 23 of 24 were sampled/)
  assert.match(header, /motion between two attached frames is not visible/)
})

test('a complete sample does not claim anything was skipped', () => {
  const complete = value({
    frameCount: 3,
    sampledFrames: [
      { position: 1, index: 0, timeMs: 0, delayMs: 50, image: {} },
      { position: 2, index: 1, timeMs: 50, delayMs: 50, image: {} },
      { position: 3, index: 2, timeMs: 100, delayMs: 50, image: {} },
    ],
  })
  const header = formatAnimationHeader(complete)
  assert.doesNotMatch(header, /were sampled/)
  assert.match(header, /Attached below are 3 frames sampled evenly in time/)
})

test('a requested sample says so instead of claiming an even spread', () => {
  const header = formatAnimationHeader(value({ sampling: 'requested' }))
  assert.match(header, /sampled as requested/)
})

test('uneven timing is called out rather than averaged away', () => {
  const header = formatAnimationHeader(value({ minDelayMs: 20, maxDelayMs: 500 }))
  assert.match(header, /uneven frame timing/)
})

test('a finite loop count is reported as a count', () => {
  const header = formatAnimationHeader(value({ loopsForever: false, loopCount: 3 }))
  assert.match(header, /loops 3 times/)
})

test('decode-time substitutions are disclosed', () => {
  const header = formatAnimationHeader(
    value({ zeroDelaysNormalized: true, missingDelays: true, transparencyFlattened: true }),
  )
  assert.match(header, /declares a 0 ms delay/)
  assert.match(header, /declares no delay/)
  assert.match(header, /flattened onto white/)
})

test('a single-frame file says it is not animated', () => {
  const header = formatAnimationHeader(
    value({ frameCount: 1, sampledFrames: [{ position: 1, index: 0, timeMs: 0, delayMs: 50, image: {} }] }),
  )
  assert.match(header, /not animated/)
})

test('every frame caption carries its index, start time, and position', () => {
  const caption = formatFrameCaption({ position: 2, index: 9, timeMs: 450, delayMs: 50 }, 24)
  assert.equal(caption, 'frame 9 of 24 (sample 2) · starts at 450 ms · displayed for 50 ms')
})

test('a frame attachment name carries its index and start time', () => {
  assert.equal(frameAttachmentName('dance.gif', { index: 9, timeMs: 450 }), 'dance.gif#frame9@450ms')
})
