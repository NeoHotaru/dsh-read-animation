#!/usr/bin/env node
/**
 * Build the frame sheet for a captured pasted animation and write it out as a PNG.
 *
 * This is what the model is handed for an animation someone pasted, so it is worth
 * being able to look at without a live session. It reads the same state file and
 * the same stored frames the plugin reads.
 *
 * Usage:
 *   node scripts/preview-sheet.mjs [attachmentId] [output.png]
 *
 * With no id, the most recently captured animation is used. `$DSH_HOME` selects
 * the home directory; it defaults to the DSH_HOME this checkout belongs to.
 *
 * @module dsh-read-animation/scripts/preview-sheet
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { loadSharp } = await import(pathToFileURL(join(REPO, 'lib', 'sharp.js')).href)
const { buildFilmstrip } = await import(pathToFileURL(join(REPO, 'lib', 'filmstrip.js')).href)
// The same header text the model is handed, so this preview cannot drift from it.
const { sheetHeader } = await import(pathToFileURL(join(REPO, 'lib', 'model.js')).href)

const dshHome = process.env.DSH_HOME ?? resolve(REPO, '..')
const stateFile = join(dshHome, 'read-animation', 'v1', 'pasted.jsonl')
const objects = join(dshHome, 'attachments', 'v1', 'objects')
const files = join(dshHome, 'attachments', 'v1', 'files')

/**
 * Where the store keeps a file's verbatim bytes.
 *
 * Mirrors `ctx.attachments.fileHostPath`, which the plugin uses for the header's
 * last line. This script has no mounted service, so the layout is spelled out
 * here — and the first version of it spelled the layout wrong, printing
 * `files/<name>` where the store uses `files/<2>/<digest>/<name>`, which put a
 * path that does not exist onto the preview. The integration harness asserts the
 * real accessor returns a real file, so only this script could drift.
 */
function keptFilePath(ref) {
  const digest = String(ref.attachmentId).replace(/^sha256:/, '')
  return join(files, digest.slice(0, 2), digest, ref.name)
}

/** Where a content-addressed attachment object lives. */
function objectPath(attachmentId) {
  const digest = String(attachmentId).replace(/^sha256:/, '')
  return join(objects, digest.slice(0, 2), digest)
}

const wanted = process.argv[2]
const out = resolve(process.argv[3] ?? join(process.cwd(), 'sheet-preview.png'))

const records = (await readFile(stateFile, 'utf8'))
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))

const record = wanted === undefined ? records.at(-1) : records.filter((r) => r.id === wanted).at(-1)
if (record === undefined) {
  console.error(wanted === undefined ? `no captured animations in ${stateFile}` : `no record for ${wanted}`)
  process.exit(1)
}

const { frames, note } = record.entry
const sharp = loadSharp()
const tiles = []
for (const [position, frame] of frames.entries()) {
  tiles.push({
    data: await readFile(objectPath(frame.attachmentId)),
    width: frame.width,
    height: frame.height,
    frame: note?.animation?.sampledFrames?.[position] ?? { index: position + 1 },
  })
}

const animation = note?.animation
const kept = record.entry.original?.file
const header = sheetHeader(animation, tiles.length, kept?.name === undefined ? undefined : keptFilePath(kept))

const sheet = await buildFilmstrip(sharp, { tiles, header, maxBytes: 4 * 1024 * 1024, maxDimension: 4096 })
await writeFile(out, sheet.data)
console.log(`${record.id}`)
console.log(`${sheet.width}x${sheet.height}, ${(sheet.data.length / 1024).toFixed(1)} KiB -> ${out}`)
