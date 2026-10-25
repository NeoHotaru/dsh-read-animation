/**
 * The sheet is the model's only view of a pasted animation, so two things are
 * worth pinning: the grid must keep tiles at their native size (a strip of eight
 * frames gets shrunk by any provider that resizes to a limit), and the text layer
 * must actually put ink on the canvas rather than silently render nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { planFrames, probeAnimation, renderFrames } from '../lib/animation.js'
import { buildFilmstrip, fitLabel, planGrid, wrapLines } from '../lib/filmstrip.js'
import { loadSharp } from '../lib/sharp.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')

test('the grid is chosen to make the sheet as square as it can be', () => {
  const portrait = planGrid(8, 240, 426)
  assert.equal(portrait.columns, 4)
  assert.equal(portrait.rows, 2)
  assert.ok(Math.abs(portrait.width / portrait.height - 1) < 0.2, `${portrait.width}x${portrait.height}`)

  // A tall source wants more columns and fewer rows; a wide one the opposite.
  assert.equal(planGrid(8, 100, 900).columns, 8)
  assert.equal(planGrid(8, 900, 100).columns, 1)
})

test('every tile gets a cell, and tiles keep their native size', () => {
  for (const count of [1, 2, 3, 5, 8, 16]) {
    const grid = planGrid(count, 240, 426)
    assert.ok(grid.columns * grid.rows >= count, `${count} tiles need ${grid.columns}x${grid.rows}`)
    assert.equal(grid.tileWidth, 240)
    assert.equal(grid.tileHeight, 426)
  }
})

test('the sheet contains every frame, the header, and the labels', async () => {
  const sharp = loadSharp()
  const bytes = await readFile(join(FIXTURES, 'moving-8f.gif'))
  const animation = await probeAnimation(sharp, bytes)
  const planned = planFrames(animation, { maxFrames: 8 })
  const frames = await renderFrames(sharp, bytes, planned, { maxEdge: 640, background: 'white' })
  assert.equal(frames.length, 8)

  const tiles = frames.map((frame) => ({
    data: frame.data,
    width: animation.width,
    height: animation.height,
    frame: { index: frame.index, delayMs: frame.delayMs, timeMs: frame.timeMs },
  }))

  const header = 'image/gif · 240x160 px · 8 frames · 640 ms · ~12 fps · loops forever\nSampled evenly, in reading order.'
  const sheet = await buildFilmstrip(sharp, {
    tiles,
    header,
    maxBytes: 8 * 1024 * 1024,
    maxDimension: 4096,
  })

  const metadata = await sharp(sheet.data).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, sheet.width)
  assert.equal(metadata.height, sheet.height)

  const grid = planGrid(8, animation.width, animation.height, 26 + 4)
  assert.equal(sheet.width, grid.width)

  // Bigger than one frame in both directions: this is a sheet, not a frame.
  assert.ok(sheet.width > animation.width, `${sheet.width} vs ${animation.width}`)
  assert.ok(sheet.height > animation.height, `${sheet.height} vs ${animation.height}`)

  // The text layer must put ink down. An SVG rasterizer built without a font
  // backend renders text as nothing at all, which would leave the model tiles of
  // unlabelled pictures and a blank header — so each piece is proved separately
  // by rendering without it and requiring the bytes to differ.
  const withoutHeader = await buildFilmstrip(sharp, {
    tiles,
    header: '',
    maxBytes: 8 * 1024 * 1024,
    maxDimension: 4096,
  })
  assert.notEqual(digest(sheet.data), digest(withoutHeader.data), 'the header drew nothing')

  const withoutFacts = await buildFilmstrip(sharp, {
    tiles: tiles.map((tile) => ({ data: tile.data, width: tile.width, height: tile.height, frame: { index: tile.frame.index } })),
    header,
    maxBytes: 8 * 1024 * 1024,
    maxDimension: 4096,
  })
  assert.notEqual(digest(sheet.data), digest(withoutFacts.data), 'the frame labels drew nothing')
})

test('a header longer than the canvas is wrapped, never clipped', () => {
  // 4x2 of 240x426 with one header line is 972 wide, so ~124 characters fit.
  const grid = planGrid(8, 240, 426, 20)
  const long = ['x'.repeat(400)]
  const wrapped = wrapLines(long, Math.floor((grid.width - 12) / 7.8))
  assert.ok(wrapped.length > 1, 'a 400-character line must not stay on one line')
  for (const line of wrapped) assert.ok(line.length <= 124, `${line.length} chars`)
})

test('a caption too wide for its tile is shortened, not allowed to bleed', () => {
  const frame = { index: 55, delayMs: 130, timeMs: 6830 }
  assert.equal(fitLabel(frame, 240), 'frame 55 (130ms) @6830ms')
  assert.equal(fitLabel(frame, 160), '#55 @6830ms')
  assert.equal(fitLabel(frame, 40), '#55')
})

test('an over-budget sheet is shrunk to fit rather than returned too large', async () => {
  const sharp = loadSharp()
  const bytes = await readFile(join(FIXTURES, 'moving-8f.gif'))
  const animation = await probeAnimation(sharp, bytes)
  const planned = planFrames(animation, { maxFrames: 8 })
  const frames = await renderFrames(sharp, bytes, planned, { maxEdge: 640, background: 'white' })
  const tiles = frames.map((frame) => ({
    data: frame.data,
    width: animation.width,
    height: animation.height,
    frame: { index: frame.index, delayMs: frame.delayMs, timeMs: frame.timeMs },
  }))

  const budget = 12 * 1024
  const sheet = await buildFilmstrip(sharp, {
    tiles,
    header: 'image/gif · 240x160 px · 8 frames · 640 ms · ~12 fps · loops forever',
    maxBytes: budget,
    maxDimension: 4096,
  })
  assert.ok(sheet.data.length <= budget, `${sheet.data.length} > ${budget}`)
  assert.ok(sheet.width >= 1 && sheet.height >= 1)
})
