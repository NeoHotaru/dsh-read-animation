/**
 * Give the model the frames of a pasted animation.
 *
 * ### The seam, and why it is this one
 *
 * The obvious place was an `llm/stream` listener, rewriting the request's image
 * block into N blocks. That is closed by design: a loop-built request "arrives
 * deep-frozen (mutation throws): its content is a pure function of the session
 * log", so a listener may read the request but never rewrite it. An earlier
 * version of this module did exactly that and silently did nothing.
 *
 * What is left is `readImageRequest(ref, target, signal)` — the method each
 * adapter calls to produce its *own* copy of one image (`dsh-llm-deepseek` and
 * `dsh-llm-pi-ai` both do). Its arguments are a reference, a size target, and a
 * signal: no frozen request, nothing to mutate. It answers with one image, so the
 * frames are composed into one sheet (`./filmstrip.js`).
 *
 * ### The identity has to be a real content digest
 *
 * `variantId` is not a label. The DeepSeek adapter persists it and validates
 * every record against `/^sha256:[0-9a-f]{64}$/` when loading its upload index,
 * and its loader swallows the failure into an *empty* index — so a hand-rolled id
 * does not fail loudly, it silently discards every other session's cached file id
 * and re-uploads everything. This module therefore hashes the bytes it produces.
 * That also stops one on-disk request-image entry from aliasing two different
 * byte streams.
 *
 * @module dsh-read-animation/model
 */

import { createHash } from 'node:crypto'

import { buildFilmstrip } from './filmstrip.js'
import { describe, warn, wrapServiceMethod } from './patch.js'
import { loadSharp } from './sharp.js'

/** Sheets held at once. Each is one animation at one size. */
const CACHE_LIMIT = 32

/**
 * The cache key for one sheet.
 *
 * The target is part of the identity: a 4 MiB budget and an 8 KiB budget are
 * different pictures, and serving one caller's sheet to another can exceed that
 * caller's byte limit — which the adapters treat as a reason to drop the image.
 *
 * @param attachmentId - the reference the caller asked about.
 * @param target - the adapter's size and byte budget.
 * @returns the cache key.
 */
export function sheetCacheKey(attachmentId, target) {
  return `${attachmentId}|${target?.width ?? '?'}x${target?.height ?? '?'}|${target?.maxBytes ?? '?'}`
}

/**
 * The request-image identity of one encoded sheet.
 *
 * A content digest, in the form the adapters validate: deterministic in the
 * inputs, and different whenever the bytes differ.
 *
 * @param data - the encoded sheet.
 * @returns `sha256:<64 hex>`.
 */
export function sheetVariantId(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/**
 * Wrap the attachment service's request read so a captured animation reaches the
 * model as a sheet of its frames.
 *
 * @param ctx - the plugin context; needs the mounted `attachments` service.
 * @param pasted - the store filled in at admission.
 * @param display - what `./display.js` installed, so this module can read frames
 *   unwrapped and can suspend the animation substitution around a fallback.
 * @returns whether the wrapper was installed.
 */
export function installModelFrames(ctx, pasted, display) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    warn(ctx, 'no attachment service is mounted; the model gets one frame')
    return false
  }
  if (typeof attachments.readImageRequest !== 'function') {
    warn(ctx, 'attachments.readImageRequest is not a function; the model gets one frame')
    return false
  }

  const sheets = new Map()

  const patch = wrapServiceMethod(attachments, 'readImageRequest', (base) =>
    async function readImageRequestServingFrames(ref, target, signal) {
      const entry = pasted.lookup(ref?.attachmentId)
      if (entry?.frames === undefined || entry.original === undefined) return base(ref, target, signal)

      const key = sheetCacheKey(ref.attachmentId, target)
      const cached = sheets.get(key)
      if (cached !== undefined) return { ...cached, attachment: ref }

      try {
        const sheet = await sheetFor(ctx, entry, ref, target, signal, display)
        while (sheets.size >= CACHE_LIMIT) sheets.delete(sheets.keys().next().value)
        sheets.set(key, sheet)
        return sheet
      } catch (error) {
        // Every failure costs the model the motion, never the request.
        warn(ctx, `could not build a frame sheet, sending one frame: ${describe(error)}`)
        return fallbackToOriginalFrame(base, ref, target, signal, display)
      }
    },
  )

  if (!patch.installed) {
    warn(ctx, 'the request wrapper did not take effect; the model gets one frame')
    return false
  }

  ctx.effect(() => () => patch.remove(), 'dsh-read-animation: frame sheet for the model')
  return true
}

/**
 * Delegate to the store's own request read with the animation substitution off.
 *
 * The store reaches the frame it re-encodes through its own `readImage` call,
 * which this plugin has wrapped. Without suspending that substitution the
 * fallback would hand the model the whole animation wherever the store decides to
 * pass bytes through unchanged — strictly worse than the single normalized frame
 * it means to send.
 */
function fallbackToOriginalFrame(base, ref, target, signal, display) {
  if (display === undefined) return base(ref, target, signal)
  return display.suspend(() => base(ref, target, signal))
}

/**
 * Read the stored frames back and compose them.
 *
 * @param ctx - the plugin context.
 * @param entry - the captured animation.
 * @param ref - the reference the adapter asked about.
 * @param target - the adapter's size and byte budget.
 * @param signal - cancellation from the adapter.
 * @param display - the display installation, for its unwrapped read.
 * @returns a `RequestImageAttachment` describing the sheet.
 */
async function sheetFor(ctx, entry, ref, target, signal, display) {
  const sharp = loadSharp()
  const readFrame =
    display === undefined ? (frame, s) => ctx.attachments.readImage(frame, s) : (frame, s) => display.readOriginal(frame, s)

  const tiles = []
  for (const [position, frame] of entry.frames.entries()) {
    const stored = await readFrame(frame, signal)
    const described = entry.note?.animation?.sampledFrames?.[position]
    tiles.push({
      data: Buffer.from(stored.data),
      width: stored.ref.width,
      height: stored.ref.height,
      frame: described ?? { index: position + 1 },
    })
  }

  const sheet = await buildFilmstrip(sharp, {
    tiles,
    header: sheetHeader(entry.note?.animation, tiles.length, hostPathOf(ctx, entry)),
    // One tile may be as large as a single frame would have been for this caller:
    // the sheet costs N tiles, not one picture multiplied by N.
    tileMaxWidth: target?.width,
    tileMaxHeight: target?.height,
    maxBytes: target?.maxBytes,
    maxDimension: 4096,
  })

  // `depth`, `space` and `hasAlpha` are the adapter's evidence about the encoded
  // bytes; publishing them without proving them would be a guess, so they come
  // from sharp's own report on the buffer being returned.
  const metadata = await sharp(sheet.data).metadata()

  return {
    variantId: sheetVariantId(sheet.data),
    attachment: ref,
    data: sheet.data,
    mediaType: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    bytes: sheet.data.length,
    width: sheet.width,
    height: sheet.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: metadata.hasAlpha === true,
  }
}

/**
 * Where the animation itself is kept, when the store can say.
 *
 * The sheet names it so the model has a route to a denser read: eight samples is
 * what fits in one image, and `read_animation(path, frames: […])` is how it asks
 * for a specific moment afterwards. Without the path it has to go looking through
 * the attachment store for the file behind the picture it was sent.
 */
function hostPathOf(ctx, entry) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || typeof attachments.fileHostPath !== 'function') return undefined
  const path = attachments.fileHostPath(entry.original.file)
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/**
 * The sheet's own header: what this animation is, and how it was sampled.
 *
 * Kept short and split on purpose. A single long line is not wrapped by anything
 * downstream — the sheet's own layout wraps each line to the canvas, and that
 * works better from meaningful breaks than from one 200-character sentence.
 *
 * Exported so the preview script renders the same text the model is handed,
 * instead of a second copy that can drift from this one.
 *
 * @param animation - the captured animation's facts, when available.
 * @param sampled - how many tiles the sheet holds.
 * @param originalPath - where the animation itself is kept, when known.
 * @returns the header, lines separated by newlines.
 */
export function sheetHeader(animation, sampled, originalPath) {
  if (animation === undefined) return `${sampled} sampled frames of one animation, in reading order`
  const total = animation.frameCount
  const fps =
    total > 1 && animation.durationMs > 0 ? ` · ~${Math.round((total * 1000) / animation.durationMs)} fps` : ''
  const timing = animation.minDelayMs === animation.maxDelayMs ? '' : ' · uneven timing'
  const loops = animation.loopsForever === true ? ' · loops forever' : ''
  const source =
    originalPath === undefined
      ? `All ${total} frames are in the file this was pasted from`
      : `All ${total} frames are at ${originalPath}`
  return (
    `${animation.mediaType} · ${animation.width}x${animation.height} px · ${total} frames · ` +
    `${animation.durationMs} ms${fps}${timing}${loops}\n` +
    `The ${sampled} tiles below are evenly spaced samples in reading order; ` +
    `each frame's index, duration and start time is printed under it.\n` +
    `${source} — read_animation on that path with explicit frame indices looks closer at any moment.`
  )
}
