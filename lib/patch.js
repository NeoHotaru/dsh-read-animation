/**
 * Install, tag, and remove one wrapper on one method of a core service.
 *
 * ### Why this is shared rather than copied three times
 *
 * Three modules wrap one method each (`admitPromptContent`, `readImage`,
 * `readImageRequest`) and all three had the same two defects.
 *
 * **The install check never fired.** Each one verified itself with
 * `service.method === wrapper`, but a cordis service is reached through a proxy
 * that re-wraps methods on every read, so that comparison is false even when the
 * patch is live. A silently failed install warned nobody. The check here reads a
 * tag *through* the wrapper instead: property access is forwarded to the
 * underlying function, so the tag is visible where identity is not.
 *
 * **Teardown was last-writer-wins.** Each install captured whatever was on the
 * method at the time, so with two overlapping installs disposing the first
 * removed the second's patch, and disposing the second restored the first's
 * already-disposed closure as a permanent own property — a dead wrapper left on a
 * live service. Here each level keeps its own identity, a level that is no longer
 * on top does nothing on removal, and removing the top level reveals the next
 * live one — or, when there is none, restores the original *shape* of the
 * property: reassigned if the service owned it, `delete`d if it was inherited, so
 * a disabled plugin leaves no proxy layer behind.
 *
 * @module dsh-read-animation/patch
 */

/** Identity of one installed level, readable through the service proxy. */
const LEVEL = Symbol.for('dsh-read-animation.patch-level')

/** Installed levels per service and method, oldest first. */
const stacks = new WeakMap()

/** The level list for one service method, created on first use. */
function stackFor(service, name) {
  let byName = stacks.get(service)
  if (byName === undefined) {
    byName = new Map()
    stacks.set(service, byName)
  }
  let stack = byName.get(name)
  if (stack === undefined) {
    stack = []
    byName.set(name, stack)
  }
  return stack
}

/** Whether a value read off a service is a wrapper this module installed. */
export function isWrapped(value) {
  return typeof value === 'function' && value[LEVEL] !== undefined
}

/**
 * Wrap one method.
 *
 * @param service - the service object; the property is read and written through
 *   whatever proxy the caller reached it by, so the write reaches the same place
 *   the real callers read from.
 * @param name - the method name.
 * @param make - `(base) => wrapper`; `base` is the method as it was before this
 *   plugin touched it, bound to the service, so a wrapper can always delegate to
 *   the real thing.
 * @returns `{ wrapper, installed, remove }`.
 */
export function wrapServiceMethod(service, name, make) {
  const stack = stackFor(service, name)
  const bottom = stack[0]
  const owned = bottom === undefined ? Object.prototype.hasOwnProperty.call(service, name) : bottom.owned
  const original = bottom === undefined ? service[name] : bottom.original

  const level = { wrapper: undefined, original, owned, live: true }

  /**
   * Delegate to whatever is directly below this level *now*.
   *
   * Resolved per call rather than captured at install time. Capturing is what
   * broke overlapping installs: removing a middle level left every level above it
   * holding a reference to a disposed closure, so the service kept calling into
   * dead code. The receiver is the service, because these implementations reach
   * their own collaborators through `this` (`admitEncodedImages` uses
   * `this.attachments`).
   */
  const base = (...args) => {
    const at = stack.indexOf(level)
    const below = at > 0 ? stack[at - 1] : undefined
    const target = below === undefined ? original : below.wrapper
    return target.apply(service, args)
  }

  const wrapper = make(base)
  level.wrapper = wrapper
  Object.defineProperty(wrapper, LEVEL, { value: level })
  stack.push(level)

  let wrote = false
  try {
    service[name] = wrapper
    wrote = true
  } catch {
    // A read-only property cannot be patched; the caller degrades to the original.
  }
  if (!wrote) {
    level.live = false
    stack.splice(stack.indexOf(level), 1)
  }

  return {
    wrapper,
    /** Whether this level is the one callers currently reach. */
    get installed() {
      return level.live && service[name]?.[LEVEL] === level
    },
    /** Take this level off, revealing the next live one or the original method. */
    remove() {
      if (!level.live) return
      level.live = false
      const at = stack.indexOf(level)
      if (at >= 0) stack.splice(at, 1)

      // A level that is no longer on top is not this one's to remove: whoever is
      // on top will reveal the right thing when it goes.
      if (service[name]?.[LEVEL] !== level) return

      const below = stack[stack.length - 1]
      try {
        if (below !== undefined) service[name] = below.wrapper
        else if (owned) service[name] = original
        else delete service[name]
      } catch {
        /* the service is going away with us; nothing to restore */
      }
    },
  }
}

/** Log one diagnostic without depending on a logger being present. */
export function warn(ctx, message) {
  const logger = ctx.get('logger') ?? ctx.logger
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`dsh-read-animation: ${message}`)
}

/** Render one caught value as a single line. */
export function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
