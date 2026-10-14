/**
 * Locating `sharp` for the test suite.
 *
 * Contributors get it from `npm install` (it is a devDependency). A machine that
 * only has DSH installed — where `sharp` lives inside the harness tree and is not
 * reachable from this repository — points `DSH_READ_ANIMATION_SHARP` at the
 * module and everything works unchanged.
 *
 * Tests that need a decoder call {@link requireSharp}, which returns `undefined`
 * when no copy can be found so the caller can skip instead of failing.
 *
 * @module test/helpers/sharp
 */

import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)

/** @type {import('sharp') | null | undefined} */
let cached

/**
 * Resolve `sharp`, or `undefined` when this machine has no copy.
 * When found through the environment, the variable is also published so
 * `lib/sharp.js` resolves the same module inside the plugin under test.
 * @returns the `sharp` module, or undefined.
 */
export function requireSharp() {
  if (cached !== undefined) return cached ?? undefined

  const override = process.env.DSH_READ_ANIMATION_SHARP
  if (typeof override === 'string' && override.trim().length > 0) {
    try {
      cached = requireFromHere(override.trim())
      return cached
    } catch {
      cached = null
      return undefined
    }
  }

  try {
    cached = requireFromHere('sharp')
  } catch {
    cached = null
    return undefined
  }
  process.env.DSH_READ_ANIMATION_SHARP = requireFromHere.resolve('sharp')
  return cached
}

/**
 * Skip the calling test when no decoder is available.
 * @param t - the Node test context.
 * @returns the `sharp` module.
 */
export function sharpOrSkip(t) {
  const sharp = requireSharp()
  if (sharp === undefined) {
    t.skip(
      'no sharp available: run "npm install", or set DSH_READ_ANIMATION_SHARP to a ' +
        'loadable sharp module (for a DSH-only machine it is under the harness install)',
    )
  }
  return sharp
}
