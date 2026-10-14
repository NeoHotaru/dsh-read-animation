/**
 * Compose the sampled frames of an animation into one labelled sheet.
 *
 * ### Why a sheet at all
 *
 * The model's copy of an image is produced by `readImageRequest(ref, target)`,
 * which answers with exactly one image. That is the only legal seam left: a
 * loop-built request arrives deep-frozen ("listeners read it, never rewrite it"),
 * so a plugin cannot duplicate an image block into several. One image is what the
 * seam offers, so the frames go into it together.
 *
 * A sheet also matches how the sequence is meant to be read. Eight separate
 * pictures leave the model to work out that they are ordered moments of one
 * thing; a sheet states it in its shape.
 *
 * ### What it deliberately does not do
 *
 * It does not scale tiles to fit a square. The grid is chosen to make the *sheet*
 * roughly square, because that is what survives a provider resizing the image to
 * its own limits — a tall strip of eight frames gets shrunk until each frame is
 * unreadable, while a 4x2 block keeps every tile near its native size. For the
 * common case (a phone-sized animation, eight samples) no tile loses a pixel.
 *
 * ### Text has a budget, so it is laid out, not hoped for
 *
 * librsvg will happily draw a line that runs off the canvas, so the header is
 * wrapped to the sheet's own width and the layout is recomputed once the wrap is
 * known. A label that cannot fit its tile is shortened rather than allowed to
 * bleed into its neighbour.
 *
 * @module dsh-read-animation/filmstrip
 */

/** Height of the per-tile caption strip, in pixels. */
const LABEL_HEIGHT = 18

/** Line height of the sheet's own header, in pixels. */
const LINE_HEIGHT = 16

/** Space between the sheet edge and the first tile. */
const MARGIN = 6

const HEADER_FONT = 14
const LABEL_FONT = 13

/**
 * Deliberately generous per-character advances, used only as a fallback when a
 * line cannot be measured. Overestimating wraps text a little early;
 * underestimating clips it, which loses the information entirely.
 */
const HEADER_CHAR = 9.2
const LABEL_CHAR = 8.4

/** Colours: a neutral dark ground reads as a machine-made sheet, not a frame. */
const BACKGROUND = { r: 16, g: 16, b: 20 }
const HEADER_COLOUR = '#e8e8ee'
const LABEL_COLOUR = '#b9b9c6'

/** Vertical space the header needs for a given number of lines. */
function headerHeightFor(lineCount) {
  return MARGIN + lineCount * LINE_HEIGHT + 4
}

/**
 * Choose the tile grid that makes the sheet closest to square.
 *
 * @param count - how many tiles there are.
 * @param tileWidth - one tile's width in pixels.
 * @param tileHeight - one tile's height in pixels.
 * @param headerHeight - vertical space reserved for the header.
 * @returns the chosen grid and the sheet's dimensions.
 */
export function planGrid(count, tileWidth, tileHeight, headerHeight = headerHeightFor(1)) {
  const blockHeight = tileHeight + LABEL_HEIGHT
  let best
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns)
    const width = columns * tileWidth + MARGIN * 2
    const height = headerHeight + rows * blockHeight + MARGIN * 2
    const score = Math.abs(width / height - 1)
    if (best === undefined || score < best.score) {
      best = { columns, rows, width, height, score, tileWidth, tileHeight }
    }
  }
  return best
}

/**
 * Break text to a character budget, preferring the existing line breaks and, at a
 * loss, whole words. A single word longer than the budget is hard-split, because
 * the alternative is losing its tail off the edge.
 */
export function wrapLines(lines, maxChars) {
  const out = []
  for (const line of lines) {
    if (line.length <= maxChars) {
      out.push(line)
      continue
    }
    let current = ''
    for (const word of line.split(' ')) {
      if (current.length === 0) {
        current = word
      } else if (current.length + 1 + word.length <= maxChars) {
        current += ` ${word}`
      } else {
        out.push(current)
        current = word
      }
      while (current.length > maxChars) {
        out.push(current.slice(0, maxChars))
        current = current.slice(maxChars)
      }
    }
    if (current.length > 0) out.push(current)
  }
  return out
}

/**
 * Fit a caption into the width of one tile, dropping the least important part
 * first: the per-frame delay, then the `frame ` prefix.
 */
export function fitLabel(frame, tileWidth) {
  const maxChars = Math.max(6, Math.floor((tileWidth - 4) / LABEL_CHAR))
  const delay = frame.delayMs === undefined ? '' : ` (${frame.delayMs}ms)`
  const at = frame.timeMs === undefined ? '' : ` @${frame.timeMs}ms`
  const full = `frame ${frame.index}${delay}${at}`
  if (full.length <= maxChars) return full
  const brief = `#${frame.index}${at}`
  if (brief.length <= maxChars) return brief
  return `#${frame.index}`
}

/**
 * Choose the sheet's layout, measuring rather than estimating.
 *
 * Wrapping the header changes how many lines it needs, which changes the header's
 * height, which can change the best grid, which changes how much width there is to
 * wrap into. Guessing a per-character advance cannot settle that: guessed too
 * small the text runs off the edge and the tail is simply lost, which is exactly
 * what a first version of this file did. So each candidate layout is rendered and
 * measured, and the character budget is corrected from the real ink width.
 */
async function layout(sharp, count, tileWidth, tileHeight, rawLines) {
  let maxChars = Number.MAX_SAFE_INTEGER
  let lines = rawLines
  let grid = planGrid(count, tileWidth, tileHeight, headerHeightFor(lines.length))

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const available = grid.width - MARGIN * 2
    const widths = await Promise.all(lines.map((line) => measureLine(sharp, line)))

    let widest = 0
    let widestLength = 1
    lines.forEach((line, index) => {
      if (widths[index] > widest) {
        widest = widths[index]
        widestLength = line.length
      }
    })
    if (widest <= available) break

    // The budget has to come from the measured line's own length: scaling the
    // previous budget instead would keep a first-pass budget of "no limit"
    // infinite for ever, and wrap nothing.
    maxChars = Math.max(16, Math.floor(widestLength * (available / widest) * 0.98))
    lines = wrapLines(rawLines, maxChars)
    grid = planGrid(count, tileWidth, tileHeight, headerHeightFor(lines.length))
  }

  return { grid, lines }
}

/**
 * How wide one header line actually renders, in pixels.
 *
 * The line is drawn alone on a wide transparent canvas and trimmed to its ink, so
 * the measurement needs no font metrics — only the same rasterizer that will draw
 * the sheet.
 */
async function measureLine(sharp, line) {
  if (line.length === 0) return 0
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="48">` +
    `<text x="2" y="24" font-family="sans-serif" font-size="${HEADER_FONT}" fill="#ffffff">${escapeXml(line)}</text>` +
    `</svg>`
  try {
    const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true })
    return info.width
  } catch {
    // A blank render cannot be trimmed; fall back to the estimate rather than
    // failing the sheet over a header.
    return line.length * HEADER_CHAR
  }
}

/**
 * Render the sheet.
 *
 * @param sharp - the loaded sharp module.
 * @param options - tiles (PNG buffers plus the frame facts for their captions),
 *   the header lines, and the byte and dimension budget the caller's target allows.
 * @returns `{ data, width, height }` for one PNG (or JPEG, if PNG cannot fit).
 */
export async function buildFilmstrip(sharp, options) {
  const { tiles, header, maxBytes, maxDimension } = options
  if (tiles.length === 0) throw new Error('a filmstrip needs at least one tile')

  const first = await sharp(tiles[0].data).metadata()
  const tileWidth = first.width
  const tileHeight = first.height
  const { grid, lines } = await layout(sharp, tiles.length, tileWidth, tileHeight, String(header ?? '').split('\n'))

  const labels = tiles.map((tile, index) => fitLabel(tile.frame ?? { index: index + 1 }, tileWidth))

  const canvas = sharp({
    create: {
      width: grid.width,
      height: grid.height,
      channels: 3,
      background: BACKGROUND,
    },
  })

  const layers = []
  for (const [index, tile] of tiles.entries()) {
    const column = index % grid.columns
    const row = Math.floor(index / grid.columns)
    const top = MARGIN + headerHeightFor(lines.length) + row * (tileHeight + LABEL_HEIGHT)
    const left = MARGIN + column * tileWidth
    // Frames from one animation share a size; resizing only guards a mixed set.
    const resized =
      tile.width === tileWidth && tile.height === tileHeight
        ? tile.data
        : await sharp(tile.data).resize(tileWidth, tileHeight, { fit: 'fill' }).png().toBuffer()
    layers.push({ input: resized, top, left })
  }

  layers.push({
    input: Buffer.from(overlaySvg(grid, lines, labels, headerHeightFor(lines.length))),
    top: 0,
    left: 0,
  })

  const composed = await canvas.composite(layers).png({ compressionLevel: 9 }).toBuffer()
  return await fitBudget(sharp, composed, { maxBytes, maxDimension })
}

/**
 * Shrink an over-budget sheet until it fits, then give up on PNG if it still does
 * not. A sheet slightly under the provider's limit is worth more than a rejected
 * request.
 *
 * Each attempt is encoded from the original bytes at the new size, so repeated
 * shrinking never compounds resampling loss, and JPEG — which actually responds
 * to a byte budget, unlike PNG on photographic content — takes over once the
 * scale gets aggressive.
 */
async function fitBudget(sharp, data, { maxBytes, maxDimension }) {
  let current = data
  let metadata = await sharp(current).metadata()

  if (maxDimension !== undefined && Math.max(metadata.width, metadata.height) > maxDimension) {
    const scale = maxDimension / Math.max(metadata.width, metadata.height)
    current = await sharp(current)
      .resize(Math.max(1, Math.round(metadata.width * scale)), Math.max(1, Math.round(metadata.height * scale)))
      .png({ compressionLevel: 9 })
      .toBuffer()
    metadata = await sharp(current).metadata()
  }

  let width = metadata.width
  let height = metadata.height
  if (maxBytes === undefined || current.length <= maxBytes) return { data: current, width, height }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ratio = Math.sqrt(maxBytes / current.length) * 0.9
    if (ratio >= 1) break
    width = Math.max(1, Math.round(width * ratio))
    height = Math.max(1, Math.round(height * ratio))
    const pipeline = sharp(data).resize(width, height)
    current =
      attempt < 2
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.jpeg({ quality: 80 }).toBuffer()
    if (current.length <= maxBytes) break
  }

  return { data: current, width, height }
}

/**
 * One SVG holding every piece of text on the sheet.
 *
 * Text is rasterized by librsvg rather than drawn glyph by glyph, so the labels
 * stay legible at any tile size. It is a single layer because a sheet's text is
 * one thing, and compositing it once keeps the pipeline to N+1 operations.
 */
function overlaySvg(grid, lines, labels, headerHeight) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${grid.width}" height="${grid.height}">`,
  ]
  lines.forEach((line, index) => {
    const baseline = MARGIN + 12 + index * LINE_HEIGHT
    parts.push(
      `<text x="${MARGIN}" y="${baseline}" font-family="sans-serif" font-size="${HEADER_FONT}" fill="${HEADER_COLOUR}">${escapeXml(line)}</text>`,
    )
  })
  labels.forEach((label, index) => {
    const column = index % grid.columns
    const row = Math.floor(index / grid.columns)
    const left = MARGIN + column * grid.tileWidth
    const top = MARGIN + headerHeight + row * (grid.tileHeight + LABEL_HEIGHT)
    const baseline = top + grid.tileHeight + 14
    parts.push(
      `<text x="${left + 2}" y="${baseline}" font-family="monospace" font-size="${LABEL_FONT}" fill="${LABEL_COLOUR}">${escapeXml(label)}</text>`,
    )
  })
  parts.push('</svg>')
  return parts.join('')
}

/** XML-escape text destined for an SVG text node. */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
