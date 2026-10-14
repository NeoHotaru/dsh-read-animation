/**
 * Show the animation, not the frame it was flattened into.
 *
 * ### Why this is the whole client-side story
 *
 * The Web UI has exactly one way to display a durable image:
 * `session.readAttachment(id)` → the Host's `ctx.attachments.readImage(ref)` →
 * `URL.createObjectURL(new Blob([bytes], { type: attachment.mediaType }))`. The
 * bytes and the media type both come from that one host call, and the browser
 * animates whatever it is handed.
 *
 * So an animated attachment renders as an animation the moment this method
 * returns the original instead of the normalized frame — no client plugin, no
 * media route, no second authorization path. The frame the store kept is a lossy
 * artifact of a normalizer that cannot represent motion; handing back the file
 * the person actually pasted is the more truthful answer to "read this stored
 * image".
 *
 * ### The trap this avoids
 *
 * `dsh-attachment-local`'s own `readImageRequest` calls `this.readImage` to get
 * the frame it re-encodes. That internal call goes through this wrapper, so a
 * request path that falls back to re-reading the attachment would serve the *raw
 * animation* to the model instead of one frame. Two things here prevent that:
 *
 * - `./model.js` uses the original read returned below for its own tile reads
 *   rather than the wrapped method.
 * - `suspend()` turns this substitution off for the duration of a nested call, so
 *   the request path's re-read sees the normalized frame it expects.
 *
 * @module dsh-read-animation/display
 */

import { describe, warn, wrapServiceMethod } from './patch.js'

/**
 * Wrap the attachment service's display read so a captured animation is served
 * as itself.
 *
 * @param ctx - the plugin context; needs the mounted `attachments` service.
 * @param pasted - the store filled in at admission.
 * @returns the unwrapped read and the suspension helper, or undefined when the
 *   wrapper could not be installed.
 */
export function installOriginalDisplay(ctx, pasted) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    warn(ctx, 'no attachment service is mounted; a pasted animation displays as one frame')
    return undefined
  }
  if (typeof attachments.readImage !== 'function') {
    warn(ctx, 'attachments.readImage is not a function; a pasted animation displays as one frame')
    return undefined
  }

  /** Non-zero while a nested call must see the normalized frame. */
  let suspended = 0
  let readOriginal

  const patch = wrapServiceMethod(attachments, 'readImage', (base) => {
    readOriginal = base
    return async function readImageServingAnimations(ref, signal) {
      if (suspended > 0) return base(ref, signal)
      const entry = pasted.lookup(ref?.attachmentId)
      if (entry?.original === undefined) return base(ref, signal)
      try {
        const data = await collect(attachments.readFileStream(entry.original.file, signal))
        return { ref: displayedRef(ref, entry.original, data.byteLength), data }
      } catch (error) {
        // A missing or unreadable original must not cost the user their picture.
        warn(ctx, `could not read the original of a pasted animation, showing one frame: ${describe(error)}`)
        return base(ref, signal)
      }
    }
  })

  if (!patch.installed) {
    warn(ctx, 'the display wrapper did not take effect; a pasted animation displays as one frame')
    return undefined
  }

  ctx.effect(() => () => patch.remove(), 'dsh-read-animation: original-animation display')

  return {
    /** Read as the store wrote it, bypassing this substitution entirely. */
    readOriginal(ref, signal) {
      return readOriginal(ref, signal)
    },
    /**
     * Run `fn` with this substitution off.
     *
     * The request path re-reads the attachment through `readImage`; without this
     * the model would be handed the whole animation where it expects the frame
     * that was normalized for it.
     */
    async suspend(fn) {
      suspended += 1
      try {
        return await fn()
      } finally {
        suspended -= 1
      }
    },
  }
}

/**
 * The reference the caller displays: the requested identity, but describing the
 * bytes actually being returned.
 *
 * `originalDimensions` is dropped deliberately — it records what normalization
 * reduced the source *to*, and nothing has been normalized this time.
 */
function displayedRef(ref, original, bytes) {
  const { originalDimensions: _reduced, ...identity } = ref ?? {}
  return {
    ...identity,
    mediaType: original.mediaType,
    bytes,
    width: original.width,
    height: original.height,
  }
}

/** Drain a bounded byte stream into one array. */
async function collect(stream) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}
