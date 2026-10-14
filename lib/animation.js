/**
 * Animation decoding and frame planning.
 *
 * Everything here is pure with respect to DSH: it takes encoded bytes plus an
 * injected `sharp`, and returns metadata and encoded PNG frames. That keeps the
 * whole decode path unit-testable without booting a harness.
 *
 * The frame extraction strategy is deliberate. Two candidates were measured on a
 * realistic 600x400, 60-frame GIF:
 *
 * - decode the whole animation as one tall strip, then slice — one decode, but
 *   the strip is `width x (height x frames)` in memory (54.9 MiB raw for that
 *   fixture, and it grows quadratically with frame count);
 * - decode each selected frame with `{ page: i }` — one frame resident at a
 *   time, and measurably *faster* here (182 ms for 8 frames at a 512 px target,
 *   versus 228 ms for the strip-plus-resize pipeline, because the strip path
 *   resizes every frame in the animation while this path resizes only the ones
 *   actually returned).
 *
 * The second strategy is used, and `test/decode.test.js` pins the correctness
 * claim it rests on: `{ page: i }` is byte-identical to frame `i` of the
 * composited strip.
 *
 * @module dsh-read-animation/animation
 */

import { Buffer } from 'node:buffer'

/** Media types this plugin treats as potentially animated. */
export const ANIMATION_MEDIA_TYPES = Object.freeze({
  gif: 'image/gif',
  webp: 'image/webp',
})

/**
 * Frame delay substituted for a missing or zero GIF delay.
 * A zero delay is not "instantaneous" in any real decoder — browsers clamp it
 * to ~100 ms so that legacy GIFs do not run at unbounded speed.
 */
export const ZERO_DELAY_SUBSTITUTE_MS = 100

/** Frames returned by one call when the model does not ask for a count. */
export const DEFAULT_MAX_FRAMES = 8

/** Hard ceiling on frames in one call, including explicitly requested ones. */
export const HARD_MAX_FRAMES = 16

/** Default long-edge size of each returned frame, in pixels. */
export const DEFAULT_MAX_EDGE = 640

/** Bounds on the per-call frame size. */
export const MIN_MAX_EDGE = 64
export const MAX_MAX_EDGE = 2048

/**
 * Decoded-pixel ceiling used when the caller supplies none.
 *
 * Matches the deployment's own `imageLimits.maxImagePixels`, so this plugin
 * refuses exactly what the attachment store would refuse. Decoding is where the
 * cost is: libvips holds roughly four bytes per pixel, so a 60 KB file whose
 * logical screen is 9000x9000 allocates about 310 MiB. An encoded-byte cap does
 * not bound that — only this does.
 */
export const DEFAULT_MAX_PIXELS = 64e6

/**
 * Decode an animation's intrinsic metadata without extracting any frame.
 * @param sharp - the resolved `sharp` module.
 * @param data - complete encoded animation bytes.
 * @param options - `maxPixels`, the decoded-pixel ceiling for one frame.
 * @returns animation facts, including per-frame delays in milliseconds.
 * @throws {Error} when the bytes are not a decodable image, are an animated
 *   PNG, which this plugin cannot decode (see {@link sniffAnimatedPng}), or
 *   declare more pixels than the ceiling allows — a small file can describe an
 *   enormous canvas, and decoding it is what costs memory.
 */
export async function probeAnimation(sharp, data, options = {}) {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS
  const metadata = await readMetadata(sharp, data, maxPixels)

  const pixels = metadata.width * metadata.height
  if (pixels > maxPixels) {
    throw new Error(
      `the animation's frame is ${metadata.width}x${metadata.height} = ${pixels} pixels, above this ` +
        `deployment's limit of ${maxPixels}; decoding it would need roughly ${Math.round((pixels * 4) / 1024 / 1024)} MiB`,
    )
  }

  if (metadata.format === 'png' && sniffAnimatedPng(data)) {
    throw new Error(
      'this file is an animated PNG (APNG), which the host image library cannot decode — ' +
        'libvips reports it as a single-frame PNG, so every frame after the first is ' +
        'unreachable. Convert it to GIF or animated WebP to read the animation, or use ' +
        'read_image to see the first frame only',
    )
  }

  const mediaType = ANIMATION_MEDIA_TYPES[metadata.format]
  const frameCount = Math.max(1, metadata.pages ?? 1)

  const { delays, missingDelays, zeroDelays } = normalizeDelays(metadata.delay, frameCount)
  const startsMs = []
  let elapsed = 0
  for (const delay of delays) {
    startsMs.push(elapsed)
    elapsed += delay
  }

  return {
    format: metadata.format,
    mediaType,
    width: metadata.width,
    height: metadata.height,
    frameCount,
    delaysMs: delays,
    startsMs,
    durationMs: elapsed,
    missingDelays,
    zeroDelays,
    loop: typeof metadata.loop === 'number' ? metadata.loop : undefined,
    // `metadata.hasAlpha` is true for essentially every GIF, including fully
    // opaque ones, so it is useless for telling the model whether anything was
    // actually flattened. The container's own transparency declaration is exact.
    usesTransparency: declaresTransparency(metadata.format, data) ?? metadata.hasAlpha === true,
  }
}

/**
 * Read the container's own transparency declaration.
 *
 * Whether a flatten changed what the model sees depends on whether the file
 * really used transparency, and `sharp` cannot answer that: `hasAlpha` reports
 * the decoded channel layout, which is present even for an all-opaque GIF. Both
 * of this plugin's formats declare it in a fixed header location, so read it
 * there instead of inferring it.
 *
 * @param format - the decoded format name.
 * @param data - complete encoded bytes.
 * @returns `true`/`false` when the format is understood, `undefined` otherwise.
 */
export function declaresTransparency(format, data) {
  if (format === 'gif') return gifDeclaresTransparency(data)
  if (format === 'webp') return webpDeclaresTransparency(data)
  return undefined
}

/** True when any GIF graphic-control extension sets the transparent-colour flag. */
function gifDeclaresTransparency(data) {
  const view = asBuffer(data)
  if (view.length < 13) return false
  if (view.toString('latin1', 0, 3) !== 'GIF') return false

  const packed = view[10]
  let offset = 13
  if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1))

  while (offset < view.length) {
    const marker = view[offset]
    if (marker === 0x3b) return false
    if (marker === 0x21) {
      const label = view[offset + 1]
      if (label === 0xf9 && offset + 3 < view.length && (view[offset + 3] & 0x01) !== 0) return true
      offset = skipGifSubBlocks(view, offset + 2)
      continue
    }
    if (marker === 0x2c) return false
    return false
  }
  return false
}

/** Advance past a GIF data-block sequence, returning the offset after its terminator. */
function skipGifSubBlocks(view, offset) {
  let cursor = offset
  while (cursor < view.length) {
    const size = view[cursor]
    if (size === 0) return cursor + 1
    cursor += size + 1
  }
  return cursor
}

/** True when the WebP `VP8X` header sets the alpha flag. */
function webpDeclaresTransparency(data) {
  const view = asBuffer(data)
  if (view.length < 21) return false
  if (view.toString('latin1', 0, 4) !== 'RIFF' || view.toString('latin1', 8, 12) !== 'WEBP') return false
  if (view.toString('latin1', 12, 16) !== 'VP8X') return false
  return (view[20] & 0x10) !== 0
}

/** View any byte sequence as a Buffer without copying when it already is one. */
function asBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Decide which frames to return, in the order they will be presented.
 *
 * Even sampling targets points in *time*, not frame indices, so an animation
 * with uneven delays is sampled the way a person scrubbing a timeline would
 * sample it. Duplicate picks are dropped: when one frame occupies a long stretch
 * of the timeline two targets can land on it, and returning the same picture
 * twice costs tokens without adding information.
 *
 * @param animation - the result of {@link probeAnimation}.
 * @param options - `frames` (explicit 0-based indices, honored in the given
 *   order), `maxFrames` (automatic sampling budget), `at` (target times in ms).
 * @returns the ordered plan plus whether the request had to be reduced.
 */
export function planFrames(animation, options = {}) {
  const { frames, maxFrames = DEFAULT_MAX_FRAMES, at } = options

  if (frames !== undefined) {
    const picked = []
    const seen = new Set()
    for (const raw of frames) {
      if (!Number.isInteger(raw) || raw < 0 || raw >= animation.frameCount) {
        throw new Error(
          `frame index ${raw} is out of range: this animation has ${animation.frameCount} ` +
            `frame${animation.frameCount === 1 ? '' : 's'}, so valid indices are 0..${animation.frameCount - 1}`,
        )
      }
      if (seen.has(raw)) continue
      seen.add(raw)
      picked.push(raw)
      if (picked.length === HARD_MAX_FRAMES) break
    }
    if (picked.length === 0) throw new Error('frames must name at least one frame index')
    return { plan: describe(animation, picked), requested: frames.length, reduced: picked.length < frames.length }
  }

  const budget = clampCount(maxFrames)
  const targets =
    at !== undefined && at.length > 0
      ? at.map(assertTime)
      : budget >= animation.frameCount
        ? // Nothing to subsample: return the animation whole. Time-based selection
          // would drop frames here for no gain — an uneven 4-frame GIF asked for 4
          // frames should produce 4 frames, not the 2 that happen to be on screen
          // longest.
          animation.delaysMs.map((_, index) => animation.startsMs[index])
        : evenTargets(animation.durationMs, budget)

  const picked = []
  const seen = new Set()
  for (const target of targets) {
    const index = frameAt(animation, target)
    if (seen.has(index)) continue
    seen.add(index)
    picked.push(index)
    if (picked.length === HARD_MAX_FRAMES) break
  }
  if (picked.length === 0) picked.push(0)

  return {
    plan: describe(animation, picked),
    requested: targets.length,
    reduced: picked.length < Math.min(targets.length, animation.frameCount),
  }
}

/**
 * Extract the planned frames as PNG bytes.
 * @param sharp - the resolved `sharp` module.
 * @param data - complete encoded animation bytes.
 * @param plan - the frame array from {@link planFrames} (`result.plan`).
 * @param options - `maxEdge` (long-edge cap, never enlarging) and `background`
 *   (`'white'` flattens transparency, `'keep'` preserves the alpha channel).
 * @param signal - optional cancellation, checked between frames.
 * @returns one entry per planned frame, in plan order.
 */
export async function renderFrames(sharp, data, plan, options = {}, signal) {
  const edge = clampEdge(options.maxEdge ?? DEFAULT_MAX_EDGE)
  const background = options.background ?? 'white'
  const out = []

  for (const frame of plan) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('read_animation aborted')

    let pipeline = sharp(data, {
      page: frame.index,
      failOn: 'error',
      limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
    })
      .rotate()
      .toColourspace('srgb')

    if (background === 'white') pipeline = pipeline.flatten({ background: '#ffffff' })

    const { data: bytes, info } = await pipeline
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true })

    out.push({ ...frame, data: bytes, width: info.width, height: info.height })
  }

  return out
}

/**
 * Detect a PNG carrying an `acTL` chunk, i.e. an APNG.
 *
 * `sharp` cannot tell an APNG from a still PNG — it reports format `png` with no
 * `pages` — so the only way to avoid silently returning frame 0 of an animation
 * is to read the chunk stream. `acTL` is required to precede `IDAT`, so the walk
 * stops there.
 *
 * @param data - complete encoded bytes.
 * @returns whether the bytes are an animated PNG.
 */
export function sniffAnimatedPng(data) {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (data.byteLength < 8) return false
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (data[i] !== PNG_SIGNATURE[i]) return false

  const view = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let offset = 8
  while (offset + 8 <= view.length) {
    const length = view.readUInt32BE(offset)
    const type = view.toString('latin1', offset + 4, offset + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    offset += 12 + length
  }
  return false
}

/** Turn a list of frame indices into the ordered per-frame descriptors the tool returns. */
function describe(animation, indices) {
  return indices.map((index, position) => ({
    position: position + 1,
    index,
    timeMs: animation.startsMs[index] ?? 0,
    delayMs: animation.delaysMs[index] ?? ZERO_DELAY_SUBSTITUTE_MS,
  }))
}

/** Read and sanity-check one frame's intrinsic metadata. */
async function readMetadata(sharp, data, maxPixels) {
  const limit = maxPixels ?? DEFAULT_MAX_PIXELS
  let metadata
  try {
    metadata = await sharp(data, { failOn: 'error', limitInputPixels: limit }).metadata()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // libvips enforces the limit before it allocates anything, which is the better
    // place to refuse — say so rather than reporting it as an undecodable file.
    if (/pixel limit/i.test(message)) {
      throw new Error(
        `the image declares more pixels than this deployment's limit of ${limit}; decoding it is what ` +
          'costs memory, so it is refused before any allocation',
      )
    }
    throw new Error(`the file could not be decoded as an image (${message})`)
  }
  if (metadata.format === undefined || metadata.width === undefined || metadata.height === undefined) {
    throw new Error('the file could not be decoded as an image')
  }
  return metadata
}

/** Expand, or substitute, the per-frame delay array to exactly `frameCount` entries. */
function normalizeDelays(delay, frameCount) {
  const raw = Array.isArray(delay) ? delay : []
  const delays = []
  let missingDelays = false
  let zeroDelays = false

  for (let i = 0; i < frameCount; i += 1) {
    const value = Number(raw[i])
    if (!Number.isFinite(value) || value < 0) {
      delays.push(ZERO_DELAY_SUBSTITUTE_MS)
      missingDelays = true
    } else if (value === 0) {
      delays.push(ZERO_DELAY_SUBSTITUTE_MS)
      zeroDelays = true
    } else {
      delays.push(Math.round(value))
    }
  }

  return { delays, missingDelays, zeroDelays }
}

/** Evenly spaced target instants across the animation's real duration. */
function evenTargets(durationMs, count) {
  if (count <= 1 || durationMs <= 0) return [0]
  const targets = []
  for (let k = 0; k < count; k += 1) targets.push(Math.round((durationMs * k) / (count - 1)))
  return targets
}

/** The frame index displayed at `timeMs`, clamped to the last frame. */
function frameAt(animation, timeMs) {
  const clamped = Math.min(Math.max(timeMs, 0), Math.max(0, animation.durationMs - 1))
  for (let i = animation.frameCount - 1; i >= 0; i -= 1) {
    if (clamped >= animation.startsMs[i]) return i
  }
  return 0
}

/** Clamp a requested automatic sample count into the supported range. */
function clampCount(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`max_frames must be a positive integer, received ${JSON.stringify(value)}`)
  }
  return Math.min(value, HARD_MAX_FRAMES)
}

/** Clamp a requested long edge into the supported range. */
function clampEdge(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_MAX_EDGE) {
    throw new Error(`max_edge must be an integer of at least ${MIN_MAX_EDGE} pixels`)
  }
  return Math.min(value, MAX_MAX_EDGE)
}

/** Validate one explicitly requested instant. */
function assertTime(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`at values must be non-negative millisecond instants, received ${JSON.stringify(value)}`)
  }
  return Math.round(value)
}
