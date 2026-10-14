/**
 * Two pure functions that decide what the model is handed.
 *
 * The identity matters more than it looks: the DeepSeek adapter persists it and
 * validates it on load, and a non-conforming value does not fail loudly — it makes
 * the adapter discard its whole upload index. The cache key matters because the
 * size the caller asked for is part of the picture.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sheetCacheKey, sheetVariantId } from '../lib/model.js'

test('a sheet identity is a real content digest', () => {
  const id = sheetVariantId(Buffer.from('sheet bytes'))
  assert.match(id, /^sha256:[0-9a-f]{64}$/, 'the adapters validate exactly this shape')
  assert.equal(id.length, 'sha256:'.length + 64)
})

test('the identity is deterministic in the bytes and differs when they differ', () => {
  assert.equal(sheetVariantId(Buffer.from('a')), sheetVariantId(Buffer.from('a')))
  assert.notEqual(sheetVariantId(Buffer.from('a')), sheetVariantId(Buffer.from('b')))
})

test('the cache key carries the size the caller asked for', () => {
  const base = sheetCacheKey('sha256:x', { width: 100, height: 200, maxBytes: 4 << 20 })
  assert.notEqual(base, sheetCacheKey('sha256:x', { width: 100, height: 200, maxBytes: 8 << 10 }))
  assert.notEqual(base, sheetCacheKey('sha256:x', { width: 50, height: 200, maxBytes: 4 << 20 }))
  assert.notEqual(base, sheetCacheKey('sha256:y', { width: 100, height: 200, maxBytes: 4 << 20 }))
  assert.equal(base, sheetCacheKey('sha256:x', { width: 100, height: 200, maxBytes: 4 << 20 }))
})

test('a missing target still produces a usable key', () => {
  assert.equal(typeof sheetCacheKey('sha256:x', undefined), 'string')
})
