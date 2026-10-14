/**
 * Argument-shape validation and the shipped schema literals.
 *
 * `lib/tool.js` ships a hand-written JSON Schema instead of calling the
 * harness's `defineTool`, so the validation it performs is this package's own
 * responsibility rather than the registry's. These tests pin that it rejects the
 * same class of malformed input, and that the spec and the compiled schema still
 * describe the same parameters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PARAMETERS, PARAMETER_SPEC, describeTool, validateArguments } from '../lib/tool.js'

test('valid arguments produce no violations', () => {
  assert.deepEqual(validateArguments({ file_path: 'a.gif' }), [])
  assert.deepEqual(
    validateArguments({ file_path: 'a.gif', frames: [0, 2], max_frames: 4, max_edge: 320 }),
    [],
  )
  assert.deepEqual(validateArguments({ file_path: 'a.gif', at: [0, 500.5] }), [])
})

test('wrong primitive types are reported with their path', () => {
  assert.deepEqual(validateArguments({ file_path: 7 }), ['arguments.file_path must be a string'])
  assert.deepEqual(validateArguments({ file_path: 'a', max_frames: '4' }), [
    'arguments.max_frames must be an integer',
  ])
  assert.deepEqual(validateArguments({ file_path: 'a', max_edge: 1.5 }), [
    'arguments.max_edge must be an integer',
  ])
})

test('non-integer frame indices are reported per element', () => {
  assert.deepEqual(validateArguments({ file_path: 'a', frames: [0, 1.5, 'x'] }), [
    'arguments.frames[1] must be an integer',
    'arguments.frames[2] must be an integer',
  ])
})

test('a scalar where an array is required is reported once', () => {
  assert.deepEqual(validateArguments({ file_path: 'a', frames: 3 }), [
    'arguments.frames must be an array of integers',
  ])
  assert.deepEqual(validateArguments({ file_path: 'a', at: 'now' }), ['arguments.at must be an array of numbers'])
})

test('non-finite instants are rejected', () => {
  assert.deepEqual(validateArguments({ file_path: 'a', at: [Number.NaN] }), [
    'arguments.at[0] must be a finite number',
  ])
})

test('a non-object argument root is rejected', () => {
  assert.deepEqual(validateArguments(null), ['arguments must be an object'])
  assert.deepEqual(validateArguments([]), ['arguments must be an object'])
  assert.deepEqual(validateArguments('a.gif'), ['arguments must be an object'])
})

test('absent optional arguments are not violations', () => {
  assert.deepEqual(validateArguments({}), [])
  assert.deepEqual(validateArguments({ file_path: 'a', frames: undefined }), [])
})

test('the shipped schema and the authoring spec describe the same parameters', () => {
  assert.deepEqual(Object.keys(PARAMETERS.properties).sort(), Object.keys(PARAMETER_SPEC).sort())
  assert.deepEqual(Object.keys(PARAMETER_SPEC).filter((key) => PARAMETER_SPEC[key].required === true), [
    'file_path',
  ])
  assert.deepEqual(PARAMETERS.required, ['file_path'])
  assert.equal(PARAMETERS.type, 'object')

  for (const [key, spec] of Object.entries(PARAMETER_SPEC)) {
    const compiled = PARAMETERS.properties[key]
    assert.equal(compiled.type, spec.type, `${key}: type`)
    assert.equal(compiled.description, spec.description, `${key}: description`)
    if (spec.type === 'array') assert.equal(compiled.items.type, spec.items.type, `${key}: items`)
  }
})

test('the description states the configured defaults', () => {
  const description = describeTool({ maxFrames: 6, maxEdge: 320 })
  assert.match(description, /defaults to 6/)
  assert.match(description, /defaults to 320/)
  assert.match(description, /Use this instead of read_image/)
})
