/**
 * The wrapper machinery decides whether a disabled plugin really detaches, and
 * whether two installs on one service can coexist.
 *
 * Both were wrong in the first version, and neither is visible without a test
 * that stacks installs: a single mount looks perfectly healthy while the teardown
 * path leaves a shadow wrapper behind, and while a disposed level can be handed
 * back to the service by a neighbour's removal.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isWrapped, missingMethods, wrapServiceMethod } from '../lib/patch.js'

/** One service shaped like the cordis ones this plugin wraps: method on the prototype. */
class MethodService {
  constructor() {
    this.calls = []
  }
  method(value) {
    this.calls.push(value)
    return `base:${value}`
  }
}

test('an installed wrapper is recognised through the property read', () => {
  const service = new MethodService()
  const patch = wrapServiceMethod(service, 'method', () => () => 'wrapped')
  assert.equal(patch.installed, true)
  assert.equal(isWrapped(service.method), true)
  assert.equal(service.method(), 'wrapped')
})

test('a wrapper delegates with the service as the receiver', () => {
  // The real implementations reach their own collaborators through `this`
  // (`admitEncodedImages` uses `this.attachments`), so a bare call from inside a
  // wrapper leaves `this` undefined and breaks them.
  const service = new MethodService()
  wrapServiceMethod(service, 'method', (base) => (value) => `wrapped(${base(value)})`)
  assert.equal(service.method('a'), 'wrapped(base:a)')
  assert.deepEqual(service.calls, ['a'])
})

test('an inherited method is deleted on removal, leaving no proxy layer', () => {
  const service = new MethodService()
  assert.equal(Object.hasOwn(service, 'method'), false)
  const patch = wrapServiceMethod(service, 'method', () => () => 'wrapped')
  assert.equal(Object.hasOwn(service, 'method'), true)
  patch.remove()
  assert.equal(Object.hasOwn(service, 'method'), false, 'a disabled plugin must not leave a shadow behind')
  assert.equal(service.method('x'), 'base:x')
})

test('an own method is restored to the exact function on removal', () => {
  const original = (value) => `base:${value}`
  const service = { method: original }
  const patch = wrapServiceMethod(service, 'method', () => () => 'wrapped')
  patch.remove()
  assert.equal(service.method, original)
})

test('stacked installs chain, and removing the lower one keeps the upper alive', () => {
  const service = new MethodService()
  const first = wrapServiceMethod(service, 'method', (base) => (value) => `first(${base(value)})`)
  const second = wrapServiceMethod(service, 'method', (base) => (value) => `second(${base(value)})`)
  assert.equal(service.method('x'), 'second(first(base:x))')

  first.remove()
  assert.equal(second.installed, true, 'a live patch must survive its neighbour being disposed')
  assert.equal(service.method('x'), 'second(base:x)', 'and must delegate to the original, not to dead code')

  second.remove()
  assert.equal(service.method('x'), 'base:x')
  assert.equal(Object.hasOwn(service, 'method'), false)
})

test('removing the top level reveals the one below it', () => {
  const service = new MethodService()
  const first = wrapServiceMethod(service, 'method', (base) => (value) => `first(${base(value)})`)
  const second = wrapServiceMethod(service, 'method', (base) => (value) => `second(${base(value)})`)
  second.remove()
  assert.equal(first.installed, true)
  assert.equal(service.method('x'), 'first(base:x)')
})

test('removal is idempotent', () => {
  const service = new MethodService()
  const patch = wrapServiceMethod(service, 'method', () => () => 'wrapped')
  patch.remove()
  patch.remove()
  assert.equal(service.method('x'), 'base:x')
})

test('a service that refuses the write reports itself uninstalled', () => {
  const service = new MethodService()
  Object.defineProperty(service, 'method', { value: service.method, writable: false, configurable: true })
  const patch = wrapServiceMethod(service, 'method', () => () => 'wrapped')
  assert.equal(patch.installed, false)
  assert.equal(service.method('x'), 'base:x')
})

test('a missing member is reported, not wrapped into existence', () => {
  // Wrapping a method the host does not have used to create the property, so the
  // service acquired a function whose only behaviour was to throw from inside a
  // call that looked ordinary.
  const service = new MethodService()
  assert.deepEqual(missingMethods(service, ['method', 'absent', 'alsoAbsent']), ['absent', 'alsoAbsent'])
  assert.deepEqual(missingMethods(service, ['method']), [])
})

test('a member that is not a function counts as missing', () => {
  assert.deepEqual(missingMethods({ method: 'a string' }, ['method']), ['method'])
})

test('an absent service is missing everything asked of it', () => {
  assert.deepEqual(missingMethods(undefined, ['a', 'b']), ['a', 'b'])
  assert.deepEqual(missingMethods(null, ['a']), ['a'])
})
