/**
 * Notice an animation being pasted, and remember what it was.
 *
 * ### Why the hook is here
 *
 * A pasted animation survives the browser intact: the chat input hands the
 * clipboard's own `File` to the upload path, and that path encodes `image/gif`
 * and `image/webp` unchanged — no canvas, no re-encode. The bytes arrive at the
 * Host whole. The Host then destroys them: `admitPromptContent` runs every image
 * through the attachment normalizer, which is single-frame by construction, and
 * the source is not kept. By the time any tool can see the attachment it is one
 * frame, so `read_animation` cannot help.
 *
 * `admitPromptContent` is the last moment the original bytes exist. This module
 * wraps it to decode the animation and store the frames — and then returns the
 * original result **unchanged**, so the message a person wrote stays exactly what
 * they wrote. `./display.js` serves the animation itself back to the UI, and
 * `./model.js` turns the frames into the model's own copy of that image.
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
 * Wrap the attachment service's prompt admission so a pasted animation's frames
 * are captured before the source bytes are discarded.
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
  if (typeof attachments.admitPromptContent !== 'function') {
    warn(ctx, 'attachments.admitPromptContent is not a function; a pasted animation stays a single frame')
    return false
  }

  const patch = wrapServiceMethod(attachments, 'admitPromptContent', (base) =>
    async function admitPromptContentCapturingAnimations(content) {
      // The caller's result is never modified. Capture is best-effort and runs on
      // the side; if it fails, the message is still exactly what was sent.
      const admitted = await base(content)
      try {
        await capture(ctx, settings, pasted, content, admitted)
      } catch (error) {
        warn(ctx, `could not capture a pasted animation: ${describe(error)}`)
      }
      return admitted
    },
  )

  if (!patch.installed) {
    warn(ctx, 'the admission wrapper did not take effect; a pasted animation stays a single frame')
    return false
  }

  ctx.effect(() => () => patch.remove(), 'dsh-read-animation: pasted-animation capture')
  return true
}

/**
 * Decode each claimed image and record its frames against the admitted reference.
 *
 * @param ctx - the plugin context.
 * @param settings - the resolved plugin configuration.
 * @param pasted - the store to record into.
 * @param content - the parts as submitted, carrying the original bytes.
 * @param admitted - the parts the service returned, carrying the references.
 */
async function capture(ctx, settings, pasted, content, admitted) {
  if (!Array.isArray(content) || !Array.isArray(admitted)) return

  const claimed = []
  content.forEach((part, index) => {
    if (part?.type === 'image' && ANIMATED_MEDIA_TYPES.has(part.mediaType)) claimed.push(index)
  })
  if (claimed.length === 0) return

  const limits = ctx.get('attachments')?.imageLimits
  const stillImages = content.filter((part) => part?.type === 'image').length - claimed.length
  const allowance = Math.max(0, (limits?.maxImagesPerMessage ?? 20) - stillImages)
  const perAnimation = Math.min(settings.maxFrames, Math.floor(allowance / claimed.length))
  if (perAnimation < 2) return

  const sharp = loadSharp()
  for (const index of claimed) {
    const target = admitted[index]
    const attachmentId = target?.type === 'image' ? target.attachment?.attachmentId : undefined
    if (attachmentId === undefined) continue

    const part = content[index]
    const bytes = Buffer.from(part.data, 'base64')
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
    const refs = await ctx.attachments.saveImages(
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
      frames: refs.map((ref) => ({
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

