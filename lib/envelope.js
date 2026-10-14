/**
 * Model-facing text for one animation read.
 *
 * The images this tool attaches carry no captions of their own, so the text is
 * the only place the model can learn that the frames are *consecutive moments of
 * one animation* rather than unrelated pictures. It therefore states, for every
 * returned frame, that frame's index and start time — and it states the sampling
 * explicitly, because a model that assumes it is seeing every frame will
 * confidently describe motion that was never displayed.
 *
 * @module dsh-read-animation/envelope
 */

/**
 * Render the header block that precedes the frame images.
 * @param value - the tool's canonical output value.
 * @returns the header text.
 */
export function formatAnimationHeader(value) {
  const a = value.animation
  const lines = [
    `<path>${value.path}</path>`,
    '<type>animation</type>',
    '<content>',
    `${a.mediaType} animation, ${a.width}x${a.height} px, ${a.frameCount} frames, ` +
      `${a.durationMs} ms total${fpsNote(a)}${loopNote(a)}.`,
  ]

  if (a.frameCount === 1) {
    lines.push('This file is not animated — it contains a single frame, attached below.')
  } else {
    lines.push(
      `Attached below are ${a.sampledFrames.length} frames sampled ${
        a.sampling === 'requested' ? 'as requested' : 'evenly in time'
      } from this animation. They are consecutive moments of the SAME animation, in time order, ` +
        'not separate images; each is preceded by its frame index and start time.',
    )
    if (a.sampledFrames.length < a.frameCount) {
      const indices = a.sampledFrames.map((f) => f.index).join(', ')
      lines.push(
        `Only frame${a.sampledFrames.length === 1 ? '' : 's'} ${indices} of ${a.frameCount} ` +
          'were sampled, so any motion between two attached frames is not visible. ' +
          'Re-read with explicit "frames" indices to inspect a specific moment, or a higher ' +
          '"max_frames" to sample more densely.',
      )
    }
  }

  const caveats = []
  if (a.zeroDelaysNormalized) {
    caveats.push(
      'The file declares a 0 ms delay on at least one frame; 100 ms was assumed for those, ' +
        'matching how browsers play such files.',
    )
  }
  if (a.missingDelays) {
    caveats.push('At least one frame declares no delay; 100 ms was assumed for it.')
  }
  if (a.transparencyFlattened) {
    caveats.push('Transparency was flattened onto white so the frames render consistently.')
  }  for (const caveat of caveats) lines.push(caveat)

  lines.push('</content>')
  return lines.join('\n')
}

/**
 * Render the one-line caption placed immediately before its frame's image.
 * @param frame - one entry of `animation.sampledFrames`.
 * @param frameCount - the animation's total frame count.
 * @returns the caption text.
 */
export function formatFrameCaption(frame, frameCount) {
  return (
    `frame ${frame.index} of ${frameCount} (sample ${frame.position}) · ` +
    `starts at ${frame.timeMs} ms · displayed for ${frame.delayMs} ms`
  )
}

/** Human-readable frame rate, when the timing is uniform enough for one to be meaningful. */
function fpsNote(a) {
  if (a.frameCount === 1 || a.durationMs <= 0) return ''
  const fps = (a.frameCount * 1000) / a.durationMs
  const rounded = Math.round(fps * 10) / 10
  const uneven = a.minDelayMs !== a.maxDelayMs ? ', uneven frame timing' : ''
  return `, ~${rounded} fps${uneven}`
}

/** How the animation repeats. */
function loopNote(a) {
  if (a.loopsForever === true) return ', loops forever'
  if (typeof a.loopCount === 'number') return `, loops ${a.loopCount} time${a.loopCount === 1 ? '' : 's'}`
  return ''
}

/**
 * The attachment display name for one frame of a pasted animation.
 *
 * This is where a frame's identity reaches the model: the harness renders every
 * image block as `Image "<name>" …`, so the index and start time travel with the
 * picture. That is what lets a pasted animation be expanded for the model without
 * a word being added to the message the person wrote.
 *
 * @param animationName - the source animation's display name.
 * @param frame - one planned frame.
 * @returns the attachment name.
 */
export function frameAttachmentName(animationName, frame) {
  return `${animationName}#frame${frame.index}@${frame.timeMs}ms`
}
