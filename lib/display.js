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
 * image", which is why this wraps the shared method rather than one caller. The
 * other callers want the same thing: ACP image blocks and session-log export are
 * both better with the animation in them.
 *
 * The model's own path is untouched: a request image comes from
 * `readImageRequest`, a different method, and stays the sampled frames.
 *
 * @module dsh-read-animation/display
 */

/**
 * Wrap the attachment service's display read so a captured animation is served
 * as itself.
 *
 * @param ctx - the plugin context; needs the mounted `attachments` service.
 * @param pasted - the store filled in at admission.
 * @returns whether the wrapper was installed.
 */
export function installOriginalDisplay(ctx, pasted) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    warn(ctx, 'no attachment service is mounted; a pasted animation displays as one frame')
    return false
  }

  const original = attachments.readImage
  if (typeof original !== 'function') {
    warn(ctx, 'attachments.readImage is not a function; a pasted animation displays as one frame')
    return false
  }
  const callOriginal = original.bind(attachments)

  const wrapper = async function readImageServingAnimations(ref, signal) {
    const entry = pasted.lookup(ref?.attachmentId)
    if (entry?.original === undefined) return callOriginal(ref, signal)
    try {
      const data = await collect(attachments.readFileStream(entry.original.file, signal))
      return { ref: displayedRef(ref, entry.original, data.byteLength), data }
    } catch (error) {
      // A missing or unreadable original must not cost the user their picture.
      warn(ctx, `could not read the original of a pasted animation, showing one frame: ${describe(error)}`)
      return callOriginal(ref, signal)
    }
  }

  try {
    attachments.readImage = wrapper
  } catch (error) {
    warn(ctx, `could not install the display wrapper: ${describe(error)}`)
    return false
  }

  // The service is reached through a context proxy that re-wraps methods on read,
  // so comparing the property to `wrapper` would always differ; comparing it to
  // the original is the question that matters.
  if (attachments.readImage === original) {
    warn(ctx, 'the display wrapper did not take effect; a pasted animation displays as one frame')
    return false
  }

  ctx.effect(
    () => () => {
      try {
        attachments.readImage = original
      } catch {
        /* the service is going away with us; nothing to restore */
      }
    },
    'dsh-read-animation: original-animation display',
  )
  return true
}

/**
 * The reference the caller displays: the requested identity, but describing the
 * bytes actually being returned.
 *
 * `originalDimensions` is dropped deliberately — it records what normalization
 * reduced the source *to*, and nothing has been normalized this time.
 *
 * @param ref - the reference the caller asked for.
 * @param original - what was captured at admission.
 * @param bytes - the byte length being returned.
 * @returns the reference to report.
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

/** Log one diagnostic without depending on a logger being present. */
function warn(ctx, message) {
  const logger = ctx.get('logger') ?? ctx.logger
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`dsh-read-animation: ${message}`)
}

/** Render one caught value as a single line. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
