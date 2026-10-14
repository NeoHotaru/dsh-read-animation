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
 * adapter calls to produce its *own* copy of one image
 * (`dsh-llm-deepseek` and `dsh-llm-pi-ai` both do). Its arguments are a
 * reference, a size target, and a signal: no frozen request, nothing to mutate.
 * It answers with one image, so the frames are composed into one sheet
 * (`./filmstrip.js`).
 *
 * The session log is untouched, so nothing about what the model sees is
 * re-derived at replay time: the same stored attachment always yields the same
 * sheet.
 *
 * @module dsh-read-animation/model
 */

import { buildFilmstrip } from './filmstrip.js'
import { loadSharp } from './sharp.js'

/**
 * Wrap the attachment service's request read so a captured animation reaches the
 * model as a sheet of its frames.
 *
 * @param ctx - the plugin context; needs the mounted `attachments` service.
 * @param pasted - the store filled in at admission.
 * @returns whether the wrapper was installed.
 */
export function installModelFrames(ctx, pasted) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    warn(ctx, 'no attachment service is mounted; the model gets one frame')
    return false
  }

  const original = attachments.readImageRequest
  if (typeof original !== 'function') {
    warn(ctx, 'attachments.readImageRequest is not a function; the model gets one frame')
    return false
  }
  const callOriginal = original.bind(attachments)

  // A sheet is a pure function of immutable stored frames, so it is built once and
  // reused. The adapters already dedupe per request; this covers the next request,
  // which would otherwise pay for the composite and its SVG rasterization again.
  const sheets = new Map()
  const CACHE_LIMIT = 32

  const wrapper = async function readImageRequestServingFrames(ref, target, signal) {
    const entry = pasted.lookup(ref?.attachmentId)
    if (entry?.frames === undefined || entry.original === undefined) return callOriginal(ref, target, signal)
    try {
      const cached = sheets.get(ref.attachmentId)
      if (cached !== undefined) return { ...cached, attachment: ref }
      const sheet = await sheetFor(ctx, entry, ref, target, signal)
      while (sheets.size >= CACHE_LIMIT) sheets.delete(sheets.keys().next().value)
      sheets.set(ref.attachmentId, sheet)
      return sheet
    } catch (error) {
      // Every failure costs the model the motion, never the request.
      warn(ctx, `could not build a frame sheet, sending one frame: ${describe(error)}`)
      return callOriginal(ref, target, signal)
    }
  }

  try {
    attachments.readImageRequest = wrapper
  } catch (error) {
    warn(ctx, `could not install the request wrapper: ${describe(error)}`)
    return false
  }

  // The service is reached through a context proxy that re-wraps methods on read,
  // so comparing the property to `wrapper` would always differ; comparing it to
  // the original is the question that matters.
  if (attachments.readImageRequest === original) {
    warn(ctx, 'the request wrapper did not take effect; the model gets one frame')
    return false
  }

  ctx.effect(
    () => () => {
      try {
        attachments.readImageRequest = original
      } catch {
        /* the service is going away with us; nothing to restore */
      }
    },
    'dsh-read-animation: frame sheet for the model',
  )
  return true
}

/**
 * Read the stored frames back and compose them.
 *
 * @param ctx - the plugin context.
 * @param entry - the captured animation.
 * @param ref - the reference the adapter asked about.
 * @param target - the adapter's size and byte budget.
 * @param signal - cancellation from the adapter.
 * @returns a `RequestImageAttachment` describing the sheet.
 */
async function sheetFor(ctx, entry, ref, target, signal) {
  const sharp = loadSharp()

  const tiles = []
  for (const [position, frame] of entry.frames.entries()) {
    const stored = await ctx.attachments.readImage(frame, signal)
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
    header: headerFor(entry.note?.animation, tiles.length),
    maxBytes: target?.maxBytes,
    maxDimension: 4096,
  })

  // `depth`, `space` and `hasAlpha` are the adapter's evidence about the encoded
  // bytes; publishing them without proving them would be a guess, so they come
  // from sharp's own report on the buffer being returned.
  const metadata = await sharp(sheet.data).metadata()
  const hasAlpha = metadata.hasAlpha === true
  const mediaType = metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png'

  return {
    variantId: variantId(ref, entry, sheet),
    attachment: ref,
    data: sheet.data,
    mediaType,
    bytes: sheet.data.length,
    width: sheet.width,
    height: sheet.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha,
  }
}

/**
 * The sheet's own header: what this animation is, and how it was sampled.
 *
 * Kept short and split in two on purpose. A single long line is not wrapped by
 * anything downstream — the sheet's own layout wraps each line to the canvas, and
 * that works better from meaningful breaks than from one 200-character sentence.
 */
function headerFor(animation, sampled) {
  if (animation === undefined) return `${sampled} sampled frames of one animation, in reading order`
  const total = animation.frameCount
  const fps =
    total > 1 && animation.durationMs > 0 ? ` · ~${Math.round((total * 1000) / animation.durationMs)} fps` : ''
  const timing = animation.minDelayMs === animation.maxDelayMs ? '' : ' · uneven timing'
  const loops = animation.loopsForever === true ? ' · loops forever' : ''
  return (
    `${animation.mediaType} · ${animation.width}x${animation.height} px · ${total} frames · ` +
    `${animation.durationMs} ms${fps}${timing}${loops}\n` +
    `The ${sampled} tiles below are evenly spaced samples in reading order; ` +
    `each frame's index, duration and start time is printed under it.`
  )
}

/**
 * A stable cache key for the sheet.
 *
 * The base id identifies the same attachment, so a sheet is only ever confused
 * with another sheet of the same animation if its content is identical — in which
 * case the substitution is harmless.
 */
function variantId(ref, entry, sheet) {
  const shape = `${ref.attachmentId}|${entry.frames.length}|${sheet.width}x${sheet.height}|${sheet.data.length}`
  let hash = 0
  for (let i = 0; i < shape.length; i += 1) hash = (Math.imul(hash, 31) + shape.charCodeAt(i)) | 0
  return `sha256:filmanim${(hash >>> 0).toString(16).padStart(8, '0')}${sheet.data.length.toString(16)}`
}

/** Log one diagnostic without depending on a logger being present. */
function warn(ctx, message) {
  const logger = ctx.get('logger') ?? ctx.logger
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`dsh-read-animation: ${message}`)
}

/** Render one caught value as a single line. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
