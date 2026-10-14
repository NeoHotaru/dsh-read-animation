/**
 * The body of `read_animation`: resolve the path, read the bytes, decode and
 * sample the animation, commit every frame to the attachment store, and return
 * the canonical value the model-facing renderer projects from.
 *
 * @module dsh-read-animation/read
 */

import { planFrames, probeAnimation, renderFrames } from './animation.js'
import { collectBytes } from './bytes.js'
import { loadSharp } from './sharp.js'

/** Media types this tool accepts, independent of what the deployment accepts for storage. */
const SUPPORTED_FORMATS = new Set(['gif', 'webp'])

/**
 * The stored attachment a path names, when it names one.
 *
 * Every image the harness stores has a normalized copy at
 * `attachments/v1/objects/<2>/<digest>`, and that is the path a model is shown for
 * an attachment it received. For an animation this plugin captured, that copy is
 * the lossy single frame and the file the person actually sent is held verbatim
 * beside it, so a model that reaches for the advertised path is asking about the
 * animation through the wrong door.
 *
 * The digest alone is enough to identify the object, so this matches on the leaf
 * name rather than on a directory layout, which also accepts a bare
 * `sha256:<digest>` — how the same object is named everywhere else in the harness.
 *
 * @param pathLike - the requested path, as written.
 * @returns `sha256:<digest>`, or undefined when this is an ordinary file.
 */
export function storedAttachmentId(pathLike) {
  if (typeof pathLike !== 'string') return undefined
  const leaf = basename(pathLike.trim())
  const bare = /^sha256:([0-9a-f]{64})$/i.exec(leaf)
  const digest = bare?.[1] ?? (/^[0-9a-f]{64}$/i.test(leaf) ? leaf : undefined)
  return digest === undefined ? undefined : `sha256:${digest.toLowerCase()}`
}

/**
 * Read one animation and turn it into frames plus a description.
 * @param ctx - the plugin context carrying `fs`, `attachments`, and optionally `llm`.
 * @param settings - the resolved plugin configuration.
 * @param args - validated tool arguments.
 * @param exec - the tool execution context.
 * @param pasted - the pasted-animation store, when that feature is enabled.
 * @returns the canonical output value.
 */
export async function readAnimation(ctx, settings, args, exec, pasted) {
  if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
    throw new Error('file_path must be a non-empty string')
  }

  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('read_animation requires a mounted attachment store')
  if (typeof attachments.saveImages !== 'function') {
    throw new Error(
      'read_animation needs attachments.saveImages() to store the frames it decodes, and this DSH build does not ' +
        'provide it; read_animation supports DSH 0.1.3-alpha.2 and later',
    )
  }
  await assertImageCapableRoute(ctx, exec, args.file_path)

  const target = await ctx.fs.resolve(args.file_path, resolveOptions(exec))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new Error(`cannot read "${target.displayPath}": not found`)
  }
  if (info.type !== 'file') {
    throw new Error(`cannot read "${target.displayPath}": not a regular file`)
  }

  const byteCap = Math.min(settings.maxInputBytes, attachments.imageLimits.maxMessageImageBytes)

  // Follow an advertised normalized copy back to the animation this plugin kept.
  // Without this, reading the path the model was shown reports that the picture
  // has one frame, which is true of that file and useless as an answer.
  const kept = await keptOriginal(ctx, attachments, pasted, target)
  const data = kept === undefined ? await ctx.fs.readBytes(target, exec.signal, byteCap) : kept.data
  const path = kept === undefined ? target.displayPath : kept.path

  // The deployment's own decoded-pixel ceiling, applied to both the probe and the
  // frame extraction. Bounding the encoded bytes does not bound decoding: a 60 KB
  // file can declare a 9000x9000 canvas, which costs about 310 MiB to decode.
  const maxPixels = attachments.imageLimits.maxImagePixels

  const sharp = loadSharp()
  const animation = await probeAnimation(sharp, data, { maxPixels })

  if (!SUPPORTED_FORMATS.has(animation.format)) {
    throw new Error(
      `cannot read "${path}" as an animation: it is ${animation.format}, and ` +
        'read_animation only handles GIF and animated WebP. Use read_image for this file.',
    )
  }

  const plan = planFrames(animation, {
    frames: args.frames,
    at: args.at,
    maxFrames: args.max_frames ?? settings.maxFrames,
  })

  const rendered = await renderFrames(
    sharp,
    data,
    plan.plan,
    { maxEdge: args.max_edge ?? settings.maxEdge, background: settings.background, maxPixels },
    exec.signal,
  )

  const refs = await attachments.saveImages(
    rendered.map((frame) => ({
      data: frame.data,
      mediaType: 'image/png',
      name: `${basename(path)}#frame${frame.index}`,
    })),
  )

  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

  const delays = animation.delaysMs
  return {
    path,
    animation: {
      mediaType: animation.mediaType,
      width: animation.width,
      height: animation.height,
      frameCount: animation.frameCount,
      durationMs: animation.durationMs,
      sampling: args.frames !== undefined ? 'requested' : animation.frameCount === 1 ? 'single' : 'even',
      minDelayMs: Math.min(...delays),
      maxDelayMs: Math.max(...delays),
      loopsForever: animation.loop === 0 || animation.loop === undefined,
      ...(typeof animation.loop === 'number' && animation.loop > 0 ? { loopCount: animation.loop } : {}),
      zeroDelaysNormalized: animation.zeroDelays,
      missingDelays: animation.missingDelays,
      transparencyFlattened: settings.background === 'white' && animation.usesTransparency === true,
      sampledFrames: rendered.map((frame, index) => ({
        position: frame.position,
        index: frame.index,
        timeMs: frame.timeMs,
        delayMs: frame.delayMs,
        image: {
          attachmentId: refs[index].attachmentId,
          mediaType: refs[index].mediaType,
          bytes: refs[index].bytes,
          width: refs[index].width,
          height: refs[index].height,
          ...(refs[index].name === undefined ? {} : { name: refs[index].name }),
          ...(refs[index].originalDimensions === undefined
            ? {}
            : {
                originalDimensions: {
                  width: refs[index].originalDimensions.width,
                  height: refs[index].originalDimensions.height,
                },
              }),
        },
      })),
    },
  }
}

/**
 * The animation this plugin kept, for a path that names its normalized copy.
 *
 * Returns the original bytes and the path they actually came from, so the caller
 * can report which file was read rather than which one was asked for. The returned
 * path is the model's route back to the same file for a denser read.
 *
 * @param ctx - the plugin context.
 * @param attachments - the mounted attachment service.
 * @param pasted - the pasted-animation store, or undefined when disabled.
 * @param target - the resolved requested path.
 * @returns `{ data, path }`, or undefined when this is not a captured animation.
 */
async function keptOriginal(ctx, attachments, pasted, target) {
  if (pasted === undefined) return undefined
  const id = storedAttachmentId(target.displayPath)
  if (id === undefined) return undefined
  const entry = pasted.lookup(id)
  if (entry?.original === undefined) return undefined

  try {
    const data = await collectBytes(attachments.readFileStream(entry.original.file))
    const host =
      typeof attachments.fileHostPath === 'function' ? attachments.fileHostPath(entry.original.file) : undefined
    return { data, path: typeof host === 'string' && host.length > 0 ? host : target.displayPath }
  } catch {
    // An unreadable original is not a reason to fail: the requested path may still
    // be a usable file in its own right.
    return undefined
  }
}

/**
 * Refuse the call when the resolved model route does not declare image input.
 *
 * Mirrors the built-in `read_image` gate for the same reason it exists there:
 * attaching images to a request the route cannot carry fails much later, and
 * with a message that does not name the cause. A deployment without an `llm`
 * service mounted (the SDK profiles) cannot be checked, so the call proceeds.
 */
async function assertImageCapableRoute(ctx, exec, requestedPath) {
  const llm = ctx.get('llm')
  if (llm === undefined) return

  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  if (provider === undefined || model === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an animation: the current model route could not be resolved`)
  }

  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot read "${requestedPath}" as an animation: model "${model}" does not declare image input; ` +
        'switch to an image-capable model to read animations',
    )
  }
}

/** Path resolution options shared with the built-in filesystem tools. */
function resolveOptions(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  return {
    ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
    signal: exec.signal,
  }
}

/** Leaf name of a display path, for attachment display names. */
function basename(displayPath) {
  const index = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'))
  return index === -1 ? displayPath : displayPath.slice(index + 1)
}
