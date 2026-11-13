/**
 * The decoded-pixel ceiling.
 *
 * Bounding the encoded bytes does not bound decoding. A 60 KB file can declare a
 * 9000x9000 canvas, and libvips holds roughly four bytes per pixel while it
 * decodes — about 310 MiB. The deployment's own attachment store refuses such a
 * file; before this guard, `read_animation` did not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MAX_PIXELS, planFrames, probeAnimation, renderFrames } from '../lib/animation.js'
import { loadSharp } from '../lib/sharp.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('the default ceiling is the deployment’s own limit', () => {
  // Matches `imageLimits.maxImagePixels` so this plugin refuses what the store refuses.
  assert.equal(DEFAULT_MAX_PIXELS, 64e6)
})

test('a frame above the decoded-pixel ceiling is refused before decoding', async () => {
  const sharp = loadSharp()
  const bytes = await readFile(join(FIXTURES, 'moving-8f.gif'))
  // Two guards can answer: libvips' own limit (enforced before it allocates) and
  // this module's explicit check. Either way the message names the limit.
  await assert.rejects(() => probeAnimation(sharp, bytes, { maxPixels: 1000 }), /this deployment's limit/)
})

test('the same file decodes when the ceiling allows it', async () => {
  const sharp = loadSharp()
  const bytes = await readFile(join(FIXTURES, 'moving-8f.gif'))
  const animation = await probeAnimation(sharp, bytes, { maxPixels: DEFAULT_MAX_PIXELS })
  assert.equal(animation.frameCount, 8)
  assert.equal(animation.width, 240)
})

test('frame extraction carries the same ceiling', async () => {
  const sharp = loadSharp()
  const bytes = await readFile(join(FIXTURES, 'moving-8f.gif'))
  const animation = await probeAnimation(sharp, bytes, { maxPixels: DEFAULT_MAX_PIXELS })
  const planned = planFrames(animation, { maxFrames: 2 })
  await assert.rejects(
    () => renderFrames(sharp, bytes, planned, { maxEdge: 640, background: 'white', maxPixels: 1000 }),
    /pixel limit|Input image exceeds/i,
  )
})
