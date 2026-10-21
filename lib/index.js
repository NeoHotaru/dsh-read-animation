/**
 * `read_animation` — let a DeepSeek Harness agent actually see an animation.
 *
 * ### The gap this fills
 *
 * The harness normalizes every stored image to a single-frame 8-bit sRGB raster
 * before it reaches a model, and it does so for animated inputs too:
 * `@deepseek-ai/dsh-attachment-local` excludes `image/gif` from pass-through and
 * re-encodes through a pipeline that never sets `animated`/`page`, so `sharp`
 * yields page 0. Read an 8-frame GIF with `read_image` and the model receives one
 * picture — the first frame — with no signal that the other seven existed.
 *
 * No layer above that can repair it: by the time a vision plugin, an image
 * router, or the LLM adapter sees the image it is already a single frame. The
 * only place the animation is still intact is the file, so the tool lives here.
 *
 * ### What it returns
 *
 * One text header describing the animation (frames, duration, frame rate,
 * looping, and exactly which frames were sampled), then one caption plus one
 * image block per sampled frame, in time order. Every frame is committed through
 * `ctx.attachments.saveImages`, so the frames get the same durable,
 * content-addressed, sandbox-respecting storage as any other harness image —
 * identical frames dedupe, and a replayed session can still read them back.
 *
 * ### Why this package imports no `@deepseek-ai/*` at runtime
 *
 * See the module comment in `./tool.js`: a `link:`ed plugin is loaded through its
 * real path, so harness imports resolve upward from the checkout and fail. The
 * tool definition is built from local literals instead.
 *
 * @module dsh-read-animation
 */

import { DEFAULT_MAX_EDGE, DEFAULT_MAX_FRAMES, HARD_MAX_FRAMES, MAX_MAX_EDGE, MIN_MAX_EDGE } from './animation.js'
import { formatAnimationHeader, formatFrameCaption } from './envelope.js'
import { installAdmissionCapture } from './admission.js'
import { createPastedStore } from './pasted.js'
import { installOriginalDisplay } from './display.js'
import { installModelFrames } from './model.js'
import { readAnimation } from './read.js'
import { missingMethods, warn } from './patch.js'
import { OUTPUT_SCHEMA, PARAMETERS, TOOL_NAME, describeTool, validateArguments } from './tool.js'

/** Cordis plugin name; matches the `id` of this bundle's `cordis.patch.yml` row. */
export const name = 'dsh-read-animation'

/** Services required before the tool can be registered. */
export const inject = ['tools', 'fs']

/** Default ceiling on the encoded animation this tool will read into memory. */
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024

/**
 * Register the tool. Deferred behind `attachments` so the tool only exists while
 * a durable image store is mounted, matching how the built-in `read_image` is
 * gated.
 * @param ctx - the plugin context carrying `tools` and `fs`.
 * @param config - optional overrides: `maxFrames`, `maxEdge`, `background`,
 *   `maxInputBytes`, `expandPastedAnimations`.
 * @returns nothing.
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  ctx.inject(['attachments'], (imageCtx) => {
    // Say what is missing once, in full, before any installer runs. Partial
    // mounting is deliberate — the tool still works on a host with `saveImages`
    // but no `readImageRequest` — so this is a report, not a refusal.
    const gaps = hostGaps(imageCtx.get('attachments'))
    if (gaps.length > 0) {
      warn(
        ctx,
        `this DSH build is missing ${gaps.length} thing${gaps.length === 1 ? '' : 's'} read_animation needs: ` +
          `${gaps.join(', ')}. Supported from DSH ${SUPPORTED_FROM}; parts of this plugin will be inert.`,
      )
    }

    let pasted
    if (settings.expandPastedAnimations) {
      // Capture at admission (the last moment the animation's bytes exist) and
      // hand the frames to the model at request time. The message is not touched.
      pasted = createPastedStore(imageCtx)
      installAdmissionCapture(imageCtx, settings, pasted)
      const display = installOriginalDisplay(imageCtx, pasted)
      installModelFrames(imageCtx, pasted, display)
    }
    // The store is handed to the tool as well: a model shown a normalized copy of
    // a pasted animation reaches for that path first, and the tool can answer with
    // the animation instead of reporting that the picture has one frame.
    registerTool(imageCtx, settings, pasted)
  })
}

/** Validate and default the row's `config:` block. */
function resolveConfig(config) {
  const settings = {
    maxFrames: config?.maxFrames ?? DEFAULT_MAX_FRAMES,
    maxEdge: config?.maxEdge ?? DEFAULT_MAX_EDGE,
    background: config?.background ?? 'white',
    maxInputBytes: config?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    expandPastedAnimations: config?.expandPastedAnimations ?? true,
  }
  if (!Number.isInteger(settings.maxFrames) || settings.maxFrames < 1 || settings.maxFrames > HARD_MAX_FRAMES) {
    throw new Error(`dsh-read-animation: maxFrames must be an integer in 1..${HARD_MAX_FRAMES}`)
  }
  if (!Number.isInteger(settings.maxEdge) || settings.maxEdge < MIN_MAX_EDGE || settings.maxEdge > MAX_MAX_EDGE) {
    throw new Error(`dsh-read-animation: maxEdge must be an integer in ${MIN_MAX_EDGE}..${MAX_MAX_EDGE}`)
  }
  if (settings.background !== 'white' && settings.background !== 'keep') {
    throw new Error('dsh-read-animation: background must be "white" or "keep"')
  }
  if (!Number.isInteger(settings.maxInputBytes) || settings.maxInputBytes < 1) {
    throw new Error('dsh-read-animation: maxInputBytes must be a positive integer')
  }
  if (typeof settings.expandPastedAnimations !== 'boolean') {
    throw new Error('dsh-read-animation: expandPastedAnimations must be a boolean')
  }
  return settings
}

/**
 * Attachment-service members this plugin calls, and the DSH version each arrived in.
 *
 * The floor is measured, not guessed: reading the published type declarations of
 * every release shows `0.1.3-alpha.2` as the first version carrying all of these,
 * and 0.1.2-rc.1 and earlier are missing `admitPromptContent`, `saveFile`,
 * `readImageRequest`, `readFileStream` and `fileHostPath` in various combinations.
 * `fileHostPath` is deliberately absent from this list: the plugin works without
 * it, and says less on the sheet when it is missing.
 */
const REQUIRED = [
  { name: 'admitPromptContent', since: '0.1.2-alpha.2' },
  { name: 'saveFile', since: '0.1.3-alpha.2' },
  { name: 'saveImages', since: '0.1.0-rc.7' },
  { name: 'readImage', since: '0.0.1-rc.1' },
  { name: 'readImageRequest', since: '0.1.2-alpha.3' },
  { name: 'readFileStream', since: '0.1.2-alpha.3' },
]

/** The supported floor, quoted in the message an unsupported host gets. */
const SUPPORTED_FROM = '0.1.3-alpha.2'

/**
 * What this host does not provide, in words the person reading the log can act on.
 *
 * Checked once at mount. Each installer also guards the method it wraps, but a
 * guard only covers the method being replaced: a host with `readImage` and no
 * `saveImages` would mount cleanly and then throw a `TypeError` from inside the
 * tool, several layers below anything that names the cause.
 */
function hostGaps(attachments) {
  if (attachments === undefined) return ['no attachment service is mounted']
  const gaps = missingMethods(attachments, REQUIRED.map((entry) => entry.name)).map(
    (name) => `attachments.${name}() (added in DSH ${REQUIRED.find((entry) => entry.name === name).since})`,
  )
  if (attachments.imageLimits === undefined) gaps.push('attachments.imageLimits')
  else if (typeof attachments.imageLimits.maxImagePixels !== 'number') {
    gaps.push('attachments.imageLimits.maxImagePixels')
  }
  return gaps
}

/** Build and register the `read_animation` tool definition. */
function registerTool(ctx, settings, pasted) {
  ctx.tools.register({
    name: TOOL_NAME,
    description: describeTool(settings),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderContent(value),
      presentationMeta: (_args, value) => ({ path: value.path, frames: value.animation.sampledFrames.length }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const violations = validateArguments(args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return readAnimation(ctx, settings, args, exec, pasted)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Read animation ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
    presentResult(args, result) {
      const meta = result.meta
      const frames = meta !== null && typeof meta === 'object' ? meta.frames : undefined
      return {
        card: 'generic',
        title:
          typeof frames === 'number' && frames > 0
            ? `Read ${frames} frame${frames === 1 ? '' : 's'} from ${args.file_path}`
            : `Read animation ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  })
}

/** Build the model-facing content: one header, then a caption and image per frame. */
function renderContent(value) {
  const blocks = [{ type: 'text', text: formatAnimationHeader(value) }]
  for (const frame of value.animation.sampledFrames) {
    blocks.push({ type: 'text', text: formatFrameCaption(frame, value.animation.frameCount) })
    blocks.push({ type: 'image', attachment: frame.image })
  }
  return blocks
}
