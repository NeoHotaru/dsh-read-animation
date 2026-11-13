/**
 * Notice an animation being pasted, and remember what it was.
 *
 * ### Why the hook is here
 *
 * A pasted animation survives the browser intact: the chat input hands the
 * clipboard's own `File` to the upload path, and that path encodes `image/gif`
 * and `image/webp` unchanged — no canvas, no re-encode. The bytes arrive at the
 * Host whole. The attachment normalizer keeps only one frame and discards the
 * source. DSH 0.2.2 runs it during raw upload, before prompt admission receives
 * an already-stored image reference.
 *
 * Both raw uploads and legacy encoded prompt admission call `saveImages`. This
 * module captures its raw inputs against the returned references, before the
 * caller can discard those bytes. The returned references remain unchanged.
 * `./display.js` serves the animation itself back to the UI, and `./model.js`
 * turns the frames into the model's own copy of that image.
 *
 * ### Why it is written defensively
 *
 * Replacing a method on a core service borrows against that service's shape, so
 * this behaves as if it were absent whenever anything is not as expected: a
 * missing method, a failed assignment, a decode that throws. Each of those paths
 * calls the original implementation and returns its result.
 *
 * @module dsh-read-animation/admission
 */

import { planFrames, probeAnimation, renderFrames } from './animation.js'
import { frameAttachmentName } from './envelope.js'
import { describe, warn, wrapServiceMethod } from './patch.js'
import { loadSharp } from './sharp.js'

/** Media types that can carry an animation; anything else is left untouched. */
const ANIMATED_MEDIA_TYPES = new Set(['image/gif', 'image/webp'])

/** Formats this plugin can decode. */
const SUPPORTED_FORMATS = new Set(['gif', 'webp'])

/**
 * Wrap image storage so uploaded and pasted animations are captured while their
 * source bytes are still available.
 *
 * @param ctx - the plugin context; needs the mounted `attachments` service.
 * @param settings - the resolved plugin configuration.
 * @param pasted - the store the captured frames are recorded in.
 * @returns whether the wrapper was installed.
 */
export function installAdmissionCapture(ctx, settings, pasted) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    warn(ctx, 'no attachment service is mounted; a pasted animation stays a single frame')
    return false
  }
  if (typeof attachments.saveImages !== 'function') {
    warn(ctx, 'attachments.saveImages is not a function; a pasted animation stays a single frame')
    return false
  }

  const patch = wrapServiceMethod(attachments, 'saveImages', (base) =>
    async function saveImagesCapturingAnimations(inputs) {
      // Capture only after the host accepts the batch. Keep its references even
      // if animation capture fails.
      const refs = await base(inputs)
      try {
        await capture(ctx, settings, pasted, inputs, refs)
      } catch (error) {
        warn(ctx, `could not capture a pasted animation: ${describe(error)}`)
      }
      return refs
    },
  )

  if (!patch.installed) {
    warn(ctx, 'the image-storage wrapper did not take effect; a pasted animation stays a single frame')
    return false
  }

  ctx.effect(() => () => patch.remove(), 'dsh-read-animation: pasted-animation capture')
  return true
}

/**
 * Decode each claimed image and record its frames against the stored reference.
 *
 * @param ctx - the plugin context.
 * @param settings - the resolved plugin configuration.
 * @param pasted - the store to record into.
 * @param inputs - image storage inputs carrying the original bytes.
 * @param refs - stored references returned in input order.
 */
async function capture(ctx, settings, pasted, inputs, refs) {
  if (!Array.isArray(inputs) || !Array.isArray(refs)) return

  const claimed = []
  inputs.forEach((input, index) => {
    if (ANIMATED_MEDIA_TYPES.has(input?.mediaType)) claimed.push(index)
  })
  if (claimed.length === 0) return

  const limits = ctx.get('attachments')?.imageLimits
  const stillImages = inputs.length - claimed.length
  const allowance = Math.max(0, (limits?.maxImagesPerMessage ?? 20) - stillImages)
  const perAnimation = Math.min(settings.maxFrames, Math.floor(allowance / claimed.length))
  if (perAnimation < 2) return

  const sharp = loadSharp()
  for (const index of claimed) {
    const attachmentId = refs[index]?.attachmentId
    if (attachmentId === undefined) continue

    const part = inputs[index]
    const bytes = Buffer.from(part.data)
    const animation = await probeAnimation(sharp, bytes, { maxPixels: limits?.maxImagePixels })
    if (!SUPPORTED_FORMATS.has(animation.format) || animation.frameCount < 2) continue

    const plan = planFrames(animation, { maxFrames: perAnimation })
    const name = displayName(part.name, animation)
    const rendered = await renderFrames(
      sharp,
      bytes,
      plan.plan,
      { maxEdge: settings.maxEdge, background: settings.background, maxPixels: limits?.maxImagePixels },
    )
    const frameRefs = await ctx.attachments.saveImages(
      rendered.map((frame) => ({
        data: frame.data,
        mediaType: 'image/png',
        // The name is where a frame's index and start time reach the model when a
        // frame is delivered on its own: the harness renders every image block as
        // `Image "<name>" …`. A sheet prints the same facts under each tile.
        name: frameAttachmentName(name, frame),
      })),
    )

    // Keep the animation itself, verbatim. This is what the Web UI displays in
    // place of the flattened frame (see ./display.js); the frames above are what
    // the model is given (see ./model.js).
    const originalFile = await ctx.attachments.saveFile({
      data: bytes,
      ...(typeof part.name === 'string' && part.name.length > 0 ? { name: part.name } : {}),
    })

    pasted.remember(attachmentId, {
      frames: frameRefs.map((ref) => ({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      })),
      original: {
        file: originalFile,
        mediaType: animation.mediaType,
        width: animation.width,
        height: animation.height,
      },
      note: {
        animation: {
          mediaType: animation.mediaType,
          width: animation.width,
          height: animation.height,
          frameCount: animation.frameCount,
          durationMs: animation.durationMs,
          minDelayMs: Math.min(...animation.delaysMs),
          maxDelayMs: Math.max(...animation.delaysMs),
          loopsForever: animation.loop === 0 || animation.loop === undefined,
          sampledFrames: rendered.map((frame) => ({
            index: frame.index,
            timeMs: frame.timeMs,
            delayMs: frame.delayMs,
          })),
        },
      },
    })
  }
}

/** A display name for the animation, falling back to a generic label. */
function displayName(name, animation) {
  if (typeof name === 'string' && name.trim().length > 0) return name
  return `pasted ${animation.mediaType.slice('image/'.length)}`
}

