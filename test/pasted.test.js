/**
 * The mapping from a message's attachment to its captured frames has to outlive
 * the process, so its log is re-read on every mount. Three properties matter, and
 * the first version had none of them: what is read back is bounded, the log does
 * not grow without limit, and a torn tail cannot make the record after it
 * unreadable.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPastedStore } from '../lib/pasted.js'

/** One entry shaped like a real capture. */
const entry = (id) => ({
  frames: [{ attachmentId: `sha256:${id}` }],
  note: { path: `${id}.gif` },
  original: { file: { attachmentId: `sha256:file-${id}` } },
})

/** Run a body with `$DSH_HOME` pointed at a scratch directory. */
async function withHome(body) {
  const scratch = await mkdtemp(join(tmpdir(), 'pasted-test-'))
  const home = join(scratch, 'home')
  await mkdir(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await body({
      file: join(home, 'read-animation', 'v1', 'pasted.jsonl'),
      ctx: { get: () => undefined },
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(scratch, { recursive: true, force: true })
  }
}

test('a record survives a fresh store', async () => {
  await withHome(async ({ ctx }) => {
    createPastedStore(ctx).remember('sha256:a', entry('a'))
    const reopened = createPastedStore(ctx)
    assert.ok(reopened.lookup('sha256:a'), 'a resumed session must still find the frames')
    assert.equal(reopened.size, 1)
  })
})

test('an attachment that was never an animation is not in the store', async () => {
  await withHome(async ({ ctx }) => {
    const store = createPastedStore(ctx)
    store.remember('sha256:a', entry('a'))
    assert.equal(store.lookup('sha256:other'), undefined)
  })
})

test('the bound applies to what is read back, not only to memory', async () => {
  await withHome(async ({ ctx, file }) => {
    const store = createPastedStore(ctx)
    for (let i = 0; i < 600; i += 1) store.remember(`sha256:${i}`, entry(String(i)))

    const reopened = createPastedStore(ctx)
    assert.ok(reopened.size <= 500, `replayed ${reopened.size} entries`)
    assert.equal(reopened.lookup('sha256:0'), undefined, 'the oldest entry must be evicted, not resurrected')
    assert.ok(reopened.lookup('sha256:599'), 'the newest entry must survive')

    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0)
    assert.ok(lines.length <= 1000, `the log kept ${lines.length} lines for at most 500 entries`)
  })
})

test('a torn tail cannot make the next record unreadable', async () => {
  await withHome(async ({ ctx, file }) => {
    createPastedStore(ctx).remember('sha256:a', entry('a'))

    // A crash part way through a write: valid JSON, no terminating newline.
    const before = await readFile(file, 'utf8')
    await writeFile(file, `${before}{"id":"sha256:torn","entry":{"frames":[`, 'utf8')

    const reopened = createPastedStore(ctx)
    assert.ok(reopened.lookup('sha256:a'), 'the intact record must still load')

    reopened.remember('sha256:b', entry('b'))
    const again = createPastedStore(ctx)
    assert.ok(again.lookup('sha256:b'), 'the record written after the tear must be readable')
    assert.ok(again.lookup('sha256:a'))
  })
})

test('a torn tail is compacted away on load', async () => {
  await withHome(async ({ ctx, file }) => {
    createPastedStore(ctx).remember('sha256:a', entry('a'))
    await writeFile(file, `${await readFile(file, 'utf8')}{"id":"torn"`, 'utf8')

    createPastedStore(ctx)
    const text = await readFile(file, 'utf8')
    assert.ok(text.endsWith('\n'), 'the log must be left in a writable state')
    assert.equal(text.includes('torn'), false, 'the unreadable tail must be gone')
  })
})

test('an unreadable log degrades to memory rather than throwing', async () => {
  await withHome(async ({ ctx, file }) => {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'not json at all\n', 'utf8')
    const store = createPastedStore(ctx)
    assert.equal(store.size, 0)
    store.remember('sha256:a', entry('a'))
    assert.ok(store.lookup('sha256:a'))
  })
})
