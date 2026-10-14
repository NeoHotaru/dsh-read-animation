/**
 * Collect a bounded byte stream into one array.
 *
 * `readFileStream` hands back an async iterable, and two callers here need the
 * whole thing in one piece: the display path, which serves an original animation
 * over the wire, and the tool, which decodes what the store kept verbatim.
 *
 * @module dsh-read-animation/bytes
 */

/**
 * Drain an async iterable of chunks.
 *
 * @param stream - the chunks, in order.
 * @returns one `Uint8Array` holding all of them.
 */
export async function collectBytes(stream) {
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
