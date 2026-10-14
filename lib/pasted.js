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
 * animation pasted before the restart.
 *
 * ### The log is append-only, so it has to be maintained
 *
 * Records are appended one JSON object per line and replayed on load, the newest
 * record for an id winning. Append-only needs three things the first version
 * lacked:
 *
 * - **A bound that applies to what is read back, not only to memory.** Eviction
 *   happened on write only, so a long file rejoined to its full length on the next
 *   load and returned entries that were supposed to be gone.
 * - **Compaction.** Without it the file only grows, and every mount re-reads it.
 * - **A torn tail must not poison the following record.** A crash part way through
 *   a write leaves a line with no terminating newline; the next append would
 *   concatenate onto it and make *that* record unreadable too. A torn tail is
 *   detected on load and compacted away, and a separator is written if one is
 *   still needed before the next append.
 *
 * Every failure here degrades to memory-only rather than throwing. A missing or
 * unwritable state directory must not stop someone pasting a picture.
 *
 * @module dsh-read-animation/pasted
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Entries kept before the oldest are forgotten. Also bounds the file. */
const MAX_ENTRIES = 500

/** Compact once the log holds this many times the entries worth keeping. */
const COMPACT_RATIO = 2

/**
 * Create the mapping store.
 * @param ctx - the plugin context, used only to locate the state directory.
 * @returns `{ remember, lookup, size }`.
 */
export function createPastedStore(ctx) {
  /** @type {Map<string, object>} */
  const entries = new Map()
  const file = stateFile(ctx)

  if (file !== undefined) {
    const torn = replay(file, entries)
    if (torn || lineCount(file) > MAX_ENTRIES * COMPACT_RATIO) compact(file, entries)
  }

  return {
    /**
     * Record what one admitted image attachment really was.
     * @param attachmentId - the id the message's image block carries.
     * @param entry - the animation's frames, description, and original file.
     */
    remember(attachmentId, entry) {
      entries.delete(attachmentId)
      entries.set(attachmentId, entry)
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
      if (file === undefined) return
      try {
        appendFileSync(file, `${JSON.stringify({ id: attachmentId, entry })}\n`)
        if (lineCount(file) > MAX_ENTRIES * COMPACT_RATIO) compact(file, entries)
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
  const resolved = resolve(root)
  return /[\\/]attachments[\\/]v1$/.test(resolved) ? dirname(dirname(resolved)) : undefined
}

/**
 * Replay an existing log into the map; the last record for an id wins.
 *
 * @param file - the state file.
 * @param entries - the map to fill.
 * @returns whether the log's last line is missing its terminating newline.
 */
function replay(file, entries) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
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
      // A torn or corrupt line; the rest of the log still loads.
    }
  }

  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
  return text.length > 0 && !text.endsWith('\n')
}

/** Count the log's lines without keeping them. */
function lineCount(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').length
  } catch {
    return 0
  }
}

/** Serialize the live entries as a fresh log. */
function serialize(entries) {
  let out = ''
  for (const [id, entry] of entries) out += `${JSON.stringify({ id, entry })}\n`
  return out
}

/** Rewrite the log so it holds exactly the live entries. */
function compact(file, entries) {
  try {
    writeFileSync(file, serialize(entries), 'utf8')
  } catch {
    // Keeping the append-only log is better than losing it.
  }
}
