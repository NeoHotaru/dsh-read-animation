/**
 * The model-facing contract: what the tool is called, what it accepts, and what
 * text and images it hands back.
 *
 * ### Why the schemas are literals instead of `defineTool`
 *
 * The harness's own tools build their definitions with `defineTool` from
 * `@deepseek-ai/dsh-tools`, which compiles a schema spec into JSON Schema and
 * wraps the body with argument validation. That is the right tool for a plugin
 * that is *installed as a package*: pnpm places it under
 * `$DSH_HOME/profiles/<name>/node_modules/`, so `@deepseek-ai/*` resolves by
 * walking up to the profile's hoisted tree.
 *
 * It is the wrong tool for a plugin *linked from a working copy*. A `link:`ed
 * package is loaded through its real path, so Node resolves its imports upward
 * from the checkout — where no `@deepseek-ai/*` exists — and the plugin fails to
 * load with ERR_MODULE_NOT_FOUND. Measured, not assumed: importing this package's
 * entry from a checkout whose `node_modules` was absent failed on exactly that.
 *
 * This module therefore ships the compiled schema as a literal, with no harness
 * import at runtime. `PARAMETER_SPEC` is kept beside it as the authoring source,
 * and the integration harness asserts that the real `defineTool` derives exactly
 * `PARAMETERS` from that spec — so the literals cannot silently drift from the
 * harness's supported subset, and a maintainer still edits a spec, not a schema.
 *
 * @module dsh-read-animation/tool
 */

import { HARD_MAX_FRAMES } from './animation.js'

/** Registered tool name. */
export const TOOL_NAME = 'read_animation'

/**
 * Authoring source for {@link PARAMETERS}, in the shape `defineTool` accepts.
 * Editing this without regenerating `PARAMETERS` fails the integration harness.
 */
export const PARAMETER_SPEC = {
  file_path: {
    type: 'string',
    required: true,
    description: 'Path to the animated GIF or animated WebP, resolved by the filesystem backend.',
  },
  frames: {
    type: 'array',
    items: { type: 'integer' },
    description: `Explicit 0-based frame indices to return instead of sampling, in the order given. At most ${HARD_MAX_FRAMES}.`,
  },
  at: {
    type: 'array',
    items: { type: 'number' },
    description: 'Millisecond instants to sample, instead of an even spread across the duration.',
  },
  max_frames: {
    type: 'integer',
    description:
      'How many frames to sample when neither frames nor at is given. Ignored when the animation has no more frames than this.',
  },
  max_edge: {
    type: 'integer',
    description: 'Long-edge size of each returned frame in pixels. Frames are never enlarged past their original size.',
  },
}

/** The compiled JSON Schema the registry advertises to the model. */
export const PARAMETERS = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: 'Path to the animated GIF or animated WebP, resolved by the filesystem backend.',
    },
    frames: {
      type: 'array',
      description: `Explicit 0-based frame indices to return instead of sampling, in the order given. At most ${HARD_MAX_FRAMES}.`,
      items: { type: 'integer' },
    },
    at: {
      type: 'array',
      description: 'Millisecond instants to sample, instead of an even spread across the duration.',
      items: { type: 'number' },
    },
    max_frames: {
      type: 'integer',
      description:
        'How many frames to sample when neither frames nor at is given. Ignored when the animation has no more frames than this.',
    },
    max_edge: {
      type: 'integer',
      description: 'Long-edge size of each returned frame in pixels. Frames are never enlarged past their original size.',
    },
  },
  required: ['file_path'],
}

/** Attachment metadata shape shared with `read_image`, so frames render identically. */
const IMAGE_VALUE_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      required: true,
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
}

/**
 * Authoring source for {@link OUTPUT_SCHEMA}, in the shape `defineTool` accepts.
 *
 * Note the `required: true` annotations: this is the *spec* form, not JSON
 * Schema. The registry rejects `required` on a non-object node, and the compiled
 * form instead carries a parent-level `required` array — which is why shipping
 * the spec form as if it were the schema makes the tool fail to register at all.
 */
export const OUTPUT_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    animation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mediaType: { type: 'string', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        frameCount: { type: 'integer', required: true },
        durationMs: { type: 'integer', required: true },
        sampledFrames: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              position: { type: 'integer', required: true },
              index: { type: 'integer', required: true },
              timeMs: { type: 'integer', required: true },
              delayMs: { type: 'integer', required: true },
              image: IMAGE_VALUE_SPEC,
            },
          },
        },
        sampling: { type: 'string', enum: ['even', 'requested', 'single'], required: true },
        minDelayMs: { type: 'integer', required: true },
        maxDelayMs: { type: 'integer', required: true },
        loopsForever: { type: 'boolean', required: true },
        loopCount: { type: 'integer' },
        zeroDelaysNormalized: { type: 'boolean', required: true },
        missingDelays: { type: 'boolean', required: true },
        transparencyFlattened: { type: 'boolean', required: true },
      },
    },
  },
}

/**
 * The canonical value every successful call returns.
 * Generated from {@link OUTPUT_SPEC}; `npm run derive-schema` reprints it and the
 * integration harness asserts the two still agree.
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    animation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mediaType: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        frameCount: { type: 'integer' },
        durationMs: { type: 'integer' },
        sampledFrames: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              position: { type: 'integer' },
              index: { type: 'integer' },
              timeMs: { type: 'integer' },
              delayMs: { type: 'integer' },
              image: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attachmentId: { type: 'string' },
                  mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
                  bytes: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                  name: { type: 'string' },
                  originalDimensions: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                    },
                    required: ['width', 'height'],
                  },
                },
                required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
              },
            },
            required: ['position', 'index', 'timeMs', 'delayMs'],
          },
        },
        sampling: { type: 'string', enum: ['even', 'requested', 'single'] },
        minDelayMs: { type: 'integer' },
        maxDelayMs: { type: 'integer' },
        loopsForever: { type: 'boolean' },
        loopCount: { type: 'integer' },
        zeroDelaysNormalized: { type: 'boolean' },
        missingDelays: { type: 'boolean' },
        transparencyFlattened: { type: 'boolean' },
      },
      required: [
        'mediaType',
        'width',
        'height',
        'frameCount',
        'durationMs',
        'sampledFrames',
        'sampling',
        'minDelayMs',
        'maxDelayMs',
        'loopsForever',
        'zeroDelaysNormalized',
        'missingDelays',
        'transparencyFlattened',
      ],
    },
  },
  required: ['path'],
}

/**
 * Type-check model-supplied arguments against {@link PARAMETERS}.
 *
 * Range and domain checks stay in the tool body, which can name the actual
 * bounds it found ("this animation has 8 frames"); this only rejects values of
 * the wrong shape, before any file or decoder work starts.
 *
 * @param args - candidate arguments, however malformed.
 * @returns path-qualified violations; empty means valid.
 */
export function validateArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments must be an object']
  }

  const violations = []
  if (args.file_path !== undefined && typeof args.file_path !== 'string') {
    violations.push('arguments.file_path must be a string')
  }
  if (Array.isArray(args.frames)) {
    args.frames.forEach((value, index) => {
      if (!Number.isInteger(value)) violations.push(`arguments.frames[${index}] must be an integer`)
    })
  } else if (args.frames !== undefined) {
    violations.push('arguments.frames must be an array of integers')
  }
  if (Array.isArray(args.at)) {
    args.at.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        violations.push(`arguments.at[${index}] must be a finite number`)
      }
    })
  } else if (args.at !== undefined) {
    violations.push('arguments.at must be an array of numbers')
  }
  for (const key of ['max_frames', 'max_edge']) {
    if (args[key] !== undefined && !Number.isInteger(args[key])) {
      violations.push(`arguments.${key} must be an integer`)
    }
  }
  return violations
}

/**
 * The tool description the model reads, with this deployment's configured
 * defaults folded in so the stated behaviour matches the actual behaviour.
 * @param settings - the resolved plugin configuration.
 * @returns the description string.
 */
export function describeTool(settings) {
  return `Read an animated GIF or animated WebP and return its frames as images.

Use this instead of read_image for any .gif, and for a .webp that might be animated. read_image delivers only a single frame for those files, so it cannot show you motion; this tool decodes every frame and attaches several of them sampled across the animation's timeline, each labelled with its frame index and start time.

Arguments:
- file_path: the animation to read.
- frames: explicit 0-based frame indices to return, in the order given (use read_animation first, then re-read with the indices you want to inspect closely). Honoured up to ${HARD_MAX_FRAMES} frames.
- at: millisecond instants to sample instead of an even spread.
- max_frames: how many frames to sample when neither frames nor at is given (this deployment defaults to ${settings.maxFrames}, maximum ${HARD_MAX_FRAMES}).
- max_edge: long-edge size of each returned frame in pixels (this deployment defaults to ${settings.maxEdge}).

Static images are refused — use read_image for those. Animated PNG (APNG) is not decodable by the host image library and is refused with an explanation rather than silently returning its first frame.`
}
