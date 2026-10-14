/**
 * Which path the tool is willing to treat as "a stored attachment".
 *
 * The model is shown a normalized single-frame copy for every image it receives,
 * and that is the path it reaches for when it wants to look at the picture again.
 * For an animation this plugin captured, following that path to the file it kept
 * is the difference between eight frames and "this picture has one frame".
 *
 * The match is deliberately narrow: a 64-hex leaf. Anything else is an ordinary
 * file, and a digest that is not in the store falls through to the normal read.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { storedAttachmentId } from '../lib/read.js'

const DIGEST = 'a1b2c3'.repeat(10) + 'abcd'

test('the digest is 64 hex digits', () => {
  assert.equal(DIGEST.length, 64)
})

test('a normalized-copy path names its attachment', () => {
  assert.equal(storedAttachmentId(`D:\\home\\attachments\\v1\\objects\\a1\\${DIGEST}`), `sha256:${DIGEST}`)
  assert.equal(storedAttachmentId(`/home/attachments/v1/objects/a1/${DIGEST}`), `sha256:${DIGEST}`)
})

test('the same object named the other way is accepted too', () => {
  assert.equal(storedAttachmentId(`sha256:${DIGEST}`), `sha256:${DIGEST}`)
  assert.equal(storedAttachmentId(DIGEST), `sha256:${DIGEST}`)
})

test('an ordinary file is not an attachment', () => {
  const ordinary = [
    'D:\\work\\dance.gif',
    'dance.gif',
    'D:\\work\\abcdef0123.gif',
    'D:\\work\\a1b2c3d4',
    'sha256:tooshort',
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'a'.repeat(65)}`,
    'D:\\home\\attachments\\v1\\files\\dance.gif',
    '',
    undefined,
    null,
  ]
  for (const path of ordinary) {
    assert.equal(storedAttachmentId(path), undefined, `treated ${String(path)} as an attachment`)
  }
})

test('case is normalized to the form the store uses', () => {
  assert.equal(storedAttachmentId(`sha256:${'A'.repeat(64)}`), `sha256:${'a'.repeat(64)}`)
})
