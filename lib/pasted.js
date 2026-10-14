/**
 * What a pasted animation became, keyed by the attachment the message carries.
 *
 * The message keeps the flat image the host normalizes an animation into, so the
 * only handle a later request has on that animation is the attachment id on that
 * image block. This store is the mapping from that id to the frames decoded at
 * admission.
 *
 * It is persisted, not just in-memory, because a session outlives the process: a
 * resumed conversation must still be able to show the model the frames of an
 * animation pasted before the restart. Entries are append-only records; loading
 * replays them, and the newest record for an id wins.
 *
 * Every failure here degrades to memory-only rather than throwing. A missing or
 * unwritable state directory must not stop someone pasting a picture.
 *
 * @module dsh-read-animation/pasted
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Entries kept before the oldest are forgotten. */
const MAX_ENTRIES = 500

/**
 * Create the mapping store.
 * @param ctx - the plugin context, used only to locate the state directory.
 * @returns `{ remember, lookup }`.
 */
export function createPastedStore(ctx) {
  /** @type {Map<string, object>} */
  const entries = new Map()
  const file = stateFile(ctx)
  if (file !== undefined) load(file, entries)

  return {
    /**
     * Record what one admitted image attachment really was.
     * @param attachmentId - the id the message's image block carries.
     * @param entry - the animation's frames, description, and original file.
     */
    remember(attachmentId, entry) {
      entries.set(attachmentId, entry)
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
      if (file === undefined) return
      try {
        appendFileSync(file, `${JSON.stringify({ id: attachmentId, entry })}\n`)
      } catch {
        // Losing persistence only costs the frames after a restart.
      }
    },

    /**
     * Look up an attachment's frames.
     * @param attachmentId - the id from a request's image block.
     * @returns the recorded frames, or undefined when this image was never an animation.
     */
    lookup(attachmentId) {
      return entries.get(attachmentId)
    },

    /** How many animations are remembered. */
    get size() {
      return entries.size
    },
  }
}

/** The state file path, or undefined when no harness home can be determined. */
function stateFile(ctx) {
  const home = dshHome(ctx)
  if (home === undefined) return undefined
  const dir = join(home, 'read-animation', 'v1')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return undefined
  }
  return join(dir, 'pasted.jsonl')
}

/**
 * Find `$DSH_HOME`.
 *
 * The environment variable is the documented source; the attachment store's own
 * root (`<home>/attachments/v1`) is the fallback for a host that does not export
 * it, and is used only after checking that it has that shape.
 */
function dshHome(ctx) {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())

  const root = ctx.get('attachments')?.root
  if (typeof root !== 'string') return undefined
  const candidate = dirname(dirname(resolve(root)))
  return /[\\/]attachments[\\/]v1$/.test(resolve(root)) ? candidate : undefined
}

/** Replay an existing log into the map; the last record for an id wins. */
function load(file, entries) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const record = JSON.parse(line)
      if (typeof record?.id === 'string' && Array.isArray(record.entry?.frames)) {
        entries.delete(record.id)
        entries.set(record.id, record.entry)
      }
    } catch {
      // A torn final line from an interrupted write; the rest still loads.
    }
  }
}
