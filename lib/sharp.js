/**
 * Lazy `sharp` acquisition.
 *
 * Every DSH deployment already ships `sharp`: `@deepseek-ai/dsh-attachment-local`
 * requires it to normalize every image the harness stores, so a native binary is
 * guaranteed to be present and loadable in the host process. That is a reason to
 * *try* the host's copy first — but not a reason to declare a peer instead of a
 * dependency: a `link:`ed checkout has no guaranteed route to the host's
 * `node_modules`, so this plugin declares `sharp` as a real dependency and treats
 * the host copy as the fallback. The cost is a second libvips in the desktop
 * process when both are present.
 *
 * The order:
 *
 * 1. `$DSH_READ_ANIMATION_SHARP`, an explicit module path — for tests and for
 *    deployments whose layout defeats the steps below;
 * 2. the plugin's own resolution chain — the normal case for an installed package,
 *    and for a checkout that has run `npm install`;
 * 3. anchored at the host's attachment store — `dsh-attachment-local` resolves
 *    `sharp` for itself successfully, so the same resolution should succeed here.
 *    Measured to work for a plugin installed inside a profile (through the shared
 *    `profiles/node_modules/@deepseek-ai` layer) and to *fail* for a `link:`ed
 *    checkout, where the nearest `@deepseek-ai` entry on the walk-up is an
 *    integration shim that exports no `./package.json`;
 * 4. anchored at the running process entry (`process.argv[1]`) — the remaining net
 *    for a `link:`ed checkout without its own install. Unverified inside Electron:
 *    the app ships `sharp` unpacked beside `app.asar`, so the walk-up should reach
 *    it, but this has not been confirmed against a real host process.
 *
 * Resolution is cached after the first success: the loader runs once per
 * process, and `sharp` is expensive to re-require.
 *
 * @module dsh-read-animation/sharp
 */

import { createRequire } from 'node:module'

const requireFromPlugin = createRequire(import.meta.url)

/** Environment variable naming an explicit `sharp` module path. */
export const SHARP_PATH_ENV = 'DSH_READ_ANIMATION_SHARP'

/** @type {import('sharp') | undefined} */
let cached

/**
 * Resolve and cache the `sharp` module.
 * @returns the `sharp` callable.
 * @throws when no resolution step can find a loadable `sharp`.
 */
export function loadSharp() {
  if (cached !== undefined) return cached
  /** @type {string[]} */
  const failures = []

  const override = process.env[SHARP_PATH_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    try {
      cached = requireFromPlugin(override.trim())
      return cached
    } catch (error) {
      failures.push(`${SHARP_PATH_ENV}: ${message(error)}`)
    }
  }

  try {
    cached = requireFromPlugin('sharp')
    return cached
  } catch (error) {
    failures.push(`plugin resolution: ${message(error)}`)
  }

  try {
    const anchor = requireFromPlugin.resolve('@deepseek-ai/dsh-attachment-local/package.json')
    cached = createRequire(anchor)('sharp')
    return cached
  } catch (error) {
    failures.push(`host attachment store: ${message(error)}`)
  }

  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    try {
      cached = createRequire(entry)('sharp')
      return cached
    } catch (error) {
      failures.push(`host process entry: ${message(error)}`)
    }
  }

  throw new Error(
    'dsh-read-animation could not load "sharp". It is a declared dependency, so this usually means ' +
      'the package was installed without one (a "link:"ed checkout needs its own install), or the ' +
      'native binary failed to build. Set ' +
      `${SHARP_PATH_ENV} to an explicit module path to override. Tried — ${failures.join('; ')}`,
  )
}

/** Render one caught value as a single line for the diagnostic above. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
