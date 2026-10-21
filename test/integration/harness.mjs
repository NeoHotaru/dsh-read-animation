/**
 * Integration harness: run `read_animation` against the real DSH services.
 *
 * The unit tests prove the decoder is correct. This proves the thing the whole
 * design rests on and that no unit test can reach: that a single tool result
 * carrying *several* image blocks survives the real tool registry and the real
 * attachment store. Nothing in the harness does this today — the built-in
 * `read_image` always returns exactly one image — so if a multi-image result is
 * refused anywhere between `execute` and `render`, the approach is wrong and the
 * design has to change rather than the tests.
 *
 * It mounts the genuine `dsh-fs-local`, `dsh-attachment-local`, `dsh-system-prompt`,
 * and `dsh-tools` plugins in-process and executes the tool for real. Only two
 * things are stubbed, both because they need a live model session: the `llm`
 * service (only asked whether the route declares image input) and the agent
 * object hanging off the execution context.
 *
 * Usage:
 *   DSH_HARNESS_MODULES=<dir with @deepseek-ai/*> node test/integration/harness.mjs
 *   npm run test:integration
 *
 * @module test/integration/harness
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ensureHarnessModules, findHarnessModules } from './link-modules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const FIXTURES = join(REPO, 'test', 'fixtures')

/** Collected assertion outcomes, so one failure does not hide the rest. */
const results = []

/** Run one named assertion and record its outcome. */
async function check(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
    console.log(`  ok   ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error })
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** All image blocks of one tool result. */
const imagesOf = (result) => result.content.filter((block) => block.type === 'image')

/** Right edge of the fixture's orange index bar, the per-frame visual marker. */
async function barRightEdge(sharp, bytes) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  let rightmost = -1
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels
      if (data[i] > 200 && data[i + 1] > 80 && data[i + 1] < 175 && data[i + 2] < 110 && x > rightmost) {
        rightmost = x
      }
    }
  }
  return rightmost
}

async function main() {
  const modulesRoot = findHarnessModules()
  if (modulesRoot === undefined) {
    console.log(
      'SKIP: no DSH package tree found.\n' +
        '      Set DSH_HARNESS_MODULES to the directory containing @deepseek-ai/* —\n' +
        '      for a global npm install that is <npm root -g>/@deepseek-ai/dsh/node_modules',
    )
    return
  }

  const linked = ensureHarnessModules(modulesRoot)
  if (linked.length > 0) console.log(`linked into node_modules: ${linked.join(', ')}`)
  process.env.DSH_READ_ANIMATION_SHARP ??= join(REPO, 'node_modules', 'sharp')

  const { Context } = await import('@deepseek-ai/cordis')
  const LocalFileSystem = (await import('@deepseek-ai/dsh-fs-local')).default
  const LocalAttachmentStore = (await import('@deepseek-ai/dsh-attachment-local')).default
  const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
  const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
  const plugin = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href)
  // Deliberately the plugin's own loader: this also proves it resolves `sharp`
  // through the same chain a real deployment would.
  const { loadSharp } = await import(pathToFileURL(join(REPO, 'lib', 'sharp.js')).href)
  const sharp = loadSharp()

  // The real runtime, so the frame-sheet path can be driven through the same
  // dispatch a live session uses instead of being asserted on its own.
  const Llm = (await import('@deepseek-ai/dsh-llm')).default
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const { deepFreeze } = await import('@deepseek-ai/dsh-util-values')

  const scratch = await mkdtemp(join(tmpdir(), 'dsh-read-animation-'))
  const dshHome = join(scratch, 'home')
  const workspace = join(scratch, 'workspace')
  await mkdir(dshHome, { recursive: true })
  await mkdir(workspace, { recursive: true })

  // The plugin locates its state directory from `$DSH_HOME` first — the same
  // variable the rest of the harness uses — so point it at the scratch home.
  // Without this the run writes plugin state into the developer's real
  // `$DSH_HOME`, which is exactly the kind of stray state a test must never leave.
  process.env.DSH_HOME = dshHome

  const ctx = new Context()
  const disposers = []
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    // Stub only what a live model session would otherwise supply. The declared
    // modalities stay mutable so the route gate can be exercised from both sides.
    let inputModalities = ['text', 'image']
    disposers.push(ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities }) }))
    await ctx.plugin(LocalAttachmentStore, { dshHome })
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(plugin, {})

    const agent = {
      options: { provider: 'harness', model: 'harness-vision' },
      session: {
        header: { cwd: workspace },
        requestHeader: () => ({ config: { provider: 'harness', model: 'harness-vision' } }),
      },
    }
    let callId = 0
    const run = (args) =>
      ctx.tools.execute({
        callId: `harness-${(callId += 1)}`,
        name: 'read_animation',
        // The registry field is `arguments`, and it must be a lossless JSON value.
        arguments: args,
        agent,
        signal: new AbortController().signal,
      })

    console.log('\nregistration:')
    const schemas = ctx.tools.schemas()
    await check('read_animation is registered', () => {
      assert.ok(
        schemas.some((t) => t.name === 'read_animation'),
        `registered: ${schemas.map((t) => t.name).join(', ') || '(none)'}`,
      )
    })
    await check('the model-facing schema hides execution details', () => {
      const schema = schemas.find((t) => t.name === 'read_animation')
      assert.deepEqual(Object.keys(schema).sort(), ['description', 'name', 'parameters'])
      assert.match(schema.description, /animated GIF/)
    })

    // --- the shipped literals must match what the harness itself derives -----
    console.log('\nschema literals:')
    const { defineTool, assertSupportedJsonSchema, assertObjectJsonSchema, valueSchemaSpecToJsonSchema } =
      await import('@deepseek-ai/dsh-tools')
    const toolModule = await import(pathToFileURL(join(REPO, 'lib', 'tool.js')).href)
    await check('the shipped parameter schema equals defineTool(spec).parameters', () => {
      const { parameters } = defineTool({
        name: 'drift-check-only',
        description: 'not registered',
        parameters: toolModule.PARAMETER_SPEC,
        output: { schema: { type: 'json' }, render: () => [] },
        async execute() {
          return null
        },
      })
      assert.deepEqual(parameters, toolModule.PARAMETERS)
    })
    await check('the shipped output schema equals the spec compiled by the harness', () => {
      assert.deepEqual(valueSchemaSpecToJsonSchema(toolModule.OUTPUT_SPEC), toolModule.OUTPUT_SCHEMA)
    })
    await check('the shipped output schema is inside the harness supported subset', () => {
      assertSupportedJsonSchema(toolModule.OUTPUT_SCHEMA)
      assertObjectJsonSchema(toolModule.OUTPUT_SCHEMA)
    })

    // --- pasted animations: captured at admission, given to the model only ----
    console.log('\npasted animation:')
    const gifBytes = await readFile(join(FIXTURES, 'moving-8f.gif'))
    const gifBase64 = gifBytes.toString('base64')

    await check('baseline: the raw service flattens a pasted animation to one frame', async () => {
      const ref = await ctx.attachments.saveImage({ data: gifBytes, mediaType: 'image/gif', name: 'flat.gif' })
      assert.notEqual(ref.mediaType, 'image/gif', 'the normalizer re-encodes a GIF')
      const stored = await ctx.attachments.readImage(ref)
      const metadata = await sharp(Buffer.from(stored.data)).metadata()
      assert.equal(metadata.pages ?? 1, 1, 'and keeps exactly one frame')
    })

    const submitted = [
      { type: 'text', text: 'look at this' },
      { type: 'image', mediaType: 'image/gif', data: gifBase64, name: 'moving-8f.gif' },
    ]
    const admitted = await ctx.attachments.admitPromptContent(submitted)

    await check('the message comes back exactly as submitted — one image, no added text', () => {
      assert.equal(admitted.length, 2, `got ${admitted.length} parts`)
      assert.equal(admitted[0].type, 'text')
      assert.equal(admitted[0].text, 'look at this')
      assert.equal(admitted[1].type, 'image')
      assert.equal(admitted.filter((part) => part.type === 'text').length, 1, 'only the user’ own text')
    })

    const messageAttachmentId = admitted[1].attachment.attachmentId
    const stateFile = join(dshHome, 'read-animation', 'v1', 'pasted.jsonl')

    await check('the frames were captured from the bytes the message no longer has', async () => {
      assert.ok(existsSync(stateFile), `expected captured frames at ${stateFile}`)
      const records = (await readFile(stateFile, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      const record = records.filter((entry) => entry.id === messageAttachmentId).at(-1)
      assert.ok(record, 'the admitted attachment id must be the key')
      assert.equal(record.entry.frames.length, 8)
      assert.match(record.entry.frames[0].name, /^moving-8f\.gif#frame0@0ms$/)
      assert.ok(record.entry.original?.file?.attachmentId, 'the animation itself is kept too')
    })

    await check('the expanded frames are distinct, ordered, real frames', async () => {
      const records = (await readFile(stateFile, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      const record = records.filter((entry) => entry.id === messageAttachmentId).at(-1)
      const edges = []
      for (const frame of record.entry.frames) {
        const stored = await ctx.attachments.readImage(frame)
        edges.push(await barRightEdge(sharp, Buffer.from(stored.data)))
      }
      assert.equal(new Set(edges).size, edges.length, `frames should differ: ${edges.join(', ')}`)
      for (let i = 1; i < edges.length; i += 1) {
        assert.ok(edges[i] > edges[i - 1], `frames should be in time order: ${edges.join(', ')}`)
      }
    })

    await check('a static image in the same batch is left exactly as it was', async () => {
      const png = await readFile(join(FIXTURES, 'still.png'))
      const single = await ctx.attachments.admitPromptContent([
        { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'still.png' },
      ])
      assert.equal(single.length, 1)
      assert.equal(single[0].type, 'image')
    })
    await check('a single-frame GIF is left alone too', async () => {
      const still = await readFile(join(FIXTURES, 'still.gif'))
      const single = await ctx.attachments.admitPromptContent([
        { type: 'image', mediaType: 'image/gif', data: still.toString('base64'), name: 'still.gif' },
      ])
      assert.equal(single.length, 1)
      assert.equal(single[0].type, 'image')
    })
    await check('an animated WebP is captured too, and its message is untouched as well', async () => {
      const webp = await readFile(join(FIXTURES, 'moving.webp'))
      const single = await ctx.attachments.admitPromptContent([
        { type: 'image', mediaType: 'image/webp', data: webp.toString('base64'), name: 'moving.webp' },
      ])
      assert.equal(single.length, 1)
      const records = (await readFile(stateFile, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      const record = records.filter((entry) => entry.id === single[0].attachment.attachmentId).at(-1)
      assert.ok(record, 'an animated WebP should have been captured')
      assert.equal(record.entry.frames.length, 8)
    })

    await check('the Web UI is served the animation itself, not the flattened frame', async () => {
      const stored = await ctx.attachments.readImage(admitted[1].attachment)
      assert.equal(stored.ref.attachmentId, admitted[1].attachment.attachmentId, 'the identity must not change')
      assert.equal(stored.ref.mediaType, 'image/gif', 'the media type drives the browser blob')
      assert.equal(stored.data.byteLength, gifBytes.byteLength, 'byte-for-byte the file the user pasted')
      const metadata = await sharp(Buffer.from(stored.data)).metadata()
      assert.equal(metadata.format, 'gif')
      assert.equal(metadata.pages, 8, 'a browser needs every frame present to animate it')
      assert.equal(stored.ref.originalDimensions, undefined, 'nothing was normalized this time')
    })

    await check('an image that was never an animation still reads through the normal path', async () => {
      const png = await readFile(join(FIXTURES, 'still.png'))
      const only = await ctx.attachments.admitPromptContent([
        { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'still.png' },
      ])
      const stored = await ctx.attachments.readImage(only[0].attachment)
      const metadata = await sharp(Buffer.from(stored.data)).metadata()
      assert.equal(metadata.format, 'png')
    })

    await check('reading the advertised normalized copy answers with the animation', async () => {
      // The model is shown `attachments/v1/objects/<2>/<digest>` for every image it
      // receives and reaches for that path first. For a captured animation it is a
      // single frame, so without following the mapping the tool answers "this
      // picture has one frame" — true of that file, useless as an answer, and
      // exactly what a live session reported back.
      const digest = messageAttachmentId.replace(/^sha256:/, '')
      const copyPath = join(dshHome, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
      const viaCopy = await run({ file_path: copyPath })

      assert.equal(viaCopy.isError, false, JSON.stringify(viaCopy.content))
      assert.equal(imagesOf(viaCopy).length, 8, `the copy path yielded ${imagesOf(viaCopy).length} frames`)
      assert.match(String(viaCopy.content[0].text), /8 frames/, 'the header must describe the animation')
      assert.match(String(viaCopy.content[0].text), /moving-8f\.gif/, 'and name the file the bytes came from')
    })

    await check('the path the sheet advertises is a real file', async () => {
      // The sheet's header tells the model where the animation itself is kept, so
      // it can ask for a denser read instead of hunting through the store. That
      // line is only useful if the accessor behind it returns something readable.
      const records = (await readFile(join(dshHome, 'read-animation', 'v1', 'pasted.jsonl'), 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      const entry = records.map((record) => record.entry).find((candidate) => candidate?.original !== undefined)
      assert.ok(entry, 'a captured animation must be on record')

      const path = ctx.attachments.fileHostPath(entry.original.file)
      assert.equal(typeof path, 'string', 'fileHostPath must name a location')
      assert.ok(existsSync(path), `${path} does not exist`)
      const bytes = await readFile(path)
      assert.equal(bytes.byteLength, entry.original.file.bytes, 'and must hold the animation itself')
    })

    // --- the real chain: llm.stream -> adapter -> readImageRequest -----------
    //
    // The seam is only worth anything if it sits on the call the adapters actually
    // make, and if it survives the request being frozen the way the agent loop
    // builds it. A stub adapter that reads images exactly as the shipped ones do
    // proves both without a provider or a credential.
    console.log('\nmodel copy of a pasted animation:')
    {
      const probeCtx = new Context()
      await probeCtx.plugin(SystemPrompt, {})
      await probeCtx.plugin(LocalFileSystem, { cwd: workspace })
      await probeCtx.plugin(LocalAttachmentStore, { dshHome })
      await probeCtx.plugin(Llm, {})
      await probeCtx.plugin(ToolRuntime, {})
      await probeCtx.plugin(plugin, {})

      const seen = []
      class FrameSheetProbe extends LlmAdapter {
        providerInfo(provider) {
          return { id: provider, name: 'Frame sheet probe' }
        }
        async prepareCall(provider, model) {
          return {
            model: {
              provider,
              id: model,
              name: 'Frame sheet probe',
              context: { contextWindow: 128000 },
              inputModalities: ['text', 'image'],
            },
            stream: async function* (options) {
              for (const message of options.messages) {
                for (const block of message.content ?? []) {
                  if (block?.type === 'image') {
                    seen.push(
                      await probeCtx.attachments.readImageRequest(block.attachment, {
                        width: 240,
                        height: 160,
                        maxPixels: 64_000_000,
                        maxBytes: 4 * 1024 * 1024,
                      }),
                    )
                  }
                }
              }
            },
          }
        }
      }
      probeCtx.llm.registerAdapter(['frame-sheet-probe'], new FrameSheetProbe())

      const probeAdmitted = await probeCtx.attachments.admitPromptContent([
        { type: 'image', mediaType: 'image/gif', data: gifBase64, name: 'moving-8f.gif' },
      ])

      await check('a frozen request still yields a frame sheet to the adapter', async () => {
        const request = deepFreeze({
          provider: 'frame-sheet-probe',
          model: 'frame-sheet-probe-vision',
          messages: [{ role: 'user', content: probeAdmitted }],
        })
        for await (const _chunk of probeCtx.llm.stream(request)) {
          // the probe adapter yields nothing; draining the stream is enough
        }
        assert.equal(seen.length, 1, `the adapter read ${seen.length} images`)
        const sheet = seen[0]
        // The exact shape the DeepSeek adapter validates when it loads its upload
        // index. A non-conforming value does not fail loudly there: its loader
        // swallows the error into an empty index, discarding every other session's
        // cached file id, so this is the shape that keeps that from happening.
        assert.match(String(sheet.variantId), /^sha256:[0-9a-f]{64}$/, 'a real content digest')
        assert.equal(sheet.attachment.attachmentId, probeAdmitted[0].attachment.attachmentId)
        const metadata = await sharp(Buffer.from(sheet.data)).metadata()
        assert.equal(metadata.width, sheet.width)
        assert.equal(metadata.height, sheet.height)
        assert.ok(sheet.width > 240, `a sheet must be wider than one frame, got ${sheet.width}`)
        assert.ok(sheet.height > 160, `a sheet must be taller than one frame, got ${sheet.height}`)
      })

      await check('two different targets do not share one sheet', async () => {
        const ref = probeAdmitted[0].attachment
        const small = await probeCtx.attachments.readImageRequest(ref, { width: 64, height: 64, maxPixels: 64_000_000, maxBytes: 8 * 1024 })
        const large = await probeCtx.attachments.readImageRequest(ref, {
          width: 240,
          height: 160,
          maxPixels: 64_000_000,
          maxBytes: 4 * 1024 * 1024,
        })
        assert.notEqual(small.bytes, large.bytes, 'the size a caller asked for is part of the picture')
        assert.ok(small.bytes <= 8 * 1024, `the small target got ${small.bytes} bytes`)
        assert.ok(
          small.width * small.height < large.width * large.height,
          `a small target must get a smaller picture: ${small.width}x${small.height} vs ${large.width}x${large.height}`,
        )
      })

      await check('a sheet-build failure falls back to one frame, never the raw animation', async () => {
        // The trap: the store reaches the frame it re-encodes through its own
        // `readImage` call, which this plugin wraps, so a fallback that re-read the
        // attachment would hand the model the whole GIF with verification skipped.
        //
        // Force the failure by making the captured record name a frame that does not
        // exist, then ask for the request image and see what comes back.
        const statePath = join(dshHome, 'read-animation', 'v1', 'pasted.jsonl')
        const saved = await readFile(statePath, 'utf8')
        const records = saved
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
        const good = records
          .map((record) => record.entry)
          .find((candidate) => candidate?.frames?.length === 8 && candidate.original !== undefined)

        const brokenEntry = structuredClone(good)
        brokenEntry.frames[3] = { ...brokenEntry.frames[3], attachmentId: `sha256:${'0'.repeat(64)}` }
        await writeFile(
          statePath,
          `${saved}${JSON.stringify({ id: probeAdmitted[0].attachment.attachmentId, entry: brokenEntry })}\n`,
          'utf8',
        )

        try {
          const broken = new Context()
          await broken.plugin(SystemPrompt, {})
          await broken.plugin(LocalFileSystem, { cwd: workspace })
          await broken.plugin(LocalAttachmentStore, { dshHome })
          await broken.plugin(ToolRuntime, {})
          await broken.plugin(plugin, {})
          const result = await broken.attachments.readImageRequest(probeAdmitted[0].attachment, {
            width: 240,
            height: 160,
            maxPixels: 64_000_000,
            maxBytes: 4 * 1024 * 1024,
          })
          assert.notEqual(result.mediaType, 'image/gif', 'the model must not be handed the animation')
          const metadata = await sharp(Buffer.from(result.data)).metadata()
          assert.equal(metadata.pages ?? 1, 1, 'the fallback must be exactly one frame')
        } finally {
          await writeFile(statePath, saved, 'utf8')
        }
      })

      await check('an animation pasted before a restart still yields a sheet', async () => {
        // A second context has its own service instances but the same state file,
        // so this is the resumed-session case: nothing captured in this process.
        const resumed = new Context()
        await resumed.plugin(SystemPrompt, {})
        await resumed.plugin(LocalFileSystem, { cwd: workspace })
        await resumed.plugin(LocalAttachmentStore, { dshHome })
        await resumed.plugin(ToolRuntime, {})
        await resumed.plugin(plugin, {})
        const sheet = await resumed.attachments.readImageRequest(probeAdmitted[0].attachment, {
          width: 240,
          height: 160,
          maxPixels: 64_000_000,
          maxBytes: 4 * 1024 * 1024,
        })
        const metadata = await sharp(Buffer.from(sheet.data)).metadata()
        assert.ok(metadata.width > 240, `got ${metadata.width}`)
      })
    }

    // --- the load-bearing case: many frames in one result -------------------
    console.log('\nmulti-image tool result:')
    const many = await run({ file_path: join(FIXTURES, 'moving-8f.gif'), max_frames: 6 })
    await check('a six-frame call succeeds', () => {
      assert.equal(many.isError, false, JSON.stringify(many.content))
      assert.equal(imagesOf(many).length, 6, `got ${imagesOf(many).length} image blocks`)
    })
    await check('each frame is captioned immediately before it', () => {
      assert.equal(
        many.content.map((b) => b.type).join(','),
        'text,text,image,text,image,text,image,text,image,text,image,text,image',
      )
    })
    await check('every frame carries its own durable attachment', () => {
      const ids = imagesOf(many).map((b) => b.attachment.attachmentId)
      assert.equal(new Set(ids).size, 6, `ids: ${ids.join(', ')}`)
      for (const id of ids) assert.match(String(id), /^sha256:[a-f0-9]{64}$/)
    })
    await check('the header describes the animation rather than listing files', () => {
      const header = many.content[0].text
      assert.match(header, /image\/gif animation, 240x160 px, 8 frames, 640 ms total/)
      assert.match(header, /SAME animation, in time order/)
      assert.match(header, /Only frames .* of 8 were sampled/)
    })

    // --- the frames are real, distinct, ordered frames ----------------------
    console.log('\nstored frames:')
    const stored = await Promise.all(
      imagesOf(many).map(async (block) => (await ctx.attachments.readImage(block.attachment)).data),
    )
    await check('every stored frame reads back as a decodable PNG of the right size', async () => {
      for (const bytes of stored) {
        const metadata = await sharp(Buffer.from(bytes)).metadata()
        assert.equal(metadata.format, 'png')
        assert.equal(metadata.width, 240)
        assert.equal(metadata.height, 160)
      }
    })
    await check('the stored frames are not the same picture repeated', () => {
      const digests = new Set(stored.map((bytes) => Buffer.from(bytes).toString('base64')))
      assert.equal(digests.size, stored.length, `${digests.size} distinct frames out of ${stored.length}`)
    })
    await check('the frames are in time order', async () => {
      const edges = []
      for (const bytes of stored) edges.push(await barRightEdge(sharp, Buffer.from(bytes)))
      for (let i = 1; i < edges.length; i += 1) {
        assert.ok(edges[i] > edges[i - 1], `frame bar edges should increase, got ${edges.join(', ')}`)
      }
    })

    // --- repeat reads reuse storage ----------------------------------------
    console.log('\nrepeat reads:')
    const explicit = await run({ file_path: join(FIXTURES, 'moving-8f.gif'), frames: [0, 2, 4] })
    await check('explicit frame indices are honoured in order', () => {
      assert.equal(explicit.isError, false, JSON.stringify(explicit.content))
      assert.equal(imagesOf(explicit).length, 3)
      assert.match(explicit.content[1].text, /^frame 0 of 8/)
      assert.match(explicit.content[3].text, /^frame 2 of 8/)
      assert.match(explicit.content[5].text, /^frame 4 of 8/)
    })
    await check('a frame already stored is deduplicated rather than copied', () => {
      const first = imagesOf(many).map((b) => b.attachment.attachmentId)
      assert.ok(
        first.includes(imagesOf(explicit)[0].attachment.attachmentId),
        'frame 0 was returned by the previous call and must reuse its attachment id',
      )
    })

    // --- refusals are refusals, not silent single frames --------------------
    console.log('\nrefusals:')
    const textOf = (result) => JSON.stringify(result.content)
    await check('an APNG fails loudly instead of yielding only its first frame', async () => {
      const result = await run({ file_path: join(FIXTURES, 'anim.apng.png') })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /animated PNG \(APNG\)/)
    })
    await check('a static PNG is redirected to read_image', async () => {
      const result = await run({ file_path: join(FIXTURES, 'still.png') })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /Use read_image for this file/)
    })
    await check('a missing file reports not found', async () => {
      const result = await run({ file_path: join(FIXTURES, 'nope.gif') })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /not found/)
    })
    await check('a non-image reports a decode failure', async () => {
      const result = await run({ file_path: join(FIXTURES, 'not-an-image.txt') })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /could not be decoded/)
    })
    await check('an out-of-range frame index is refused', async () => {
      const result = await run({ file_path: join(FIXTURES, 'moving-8f.gif'), frames: [99] })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /out of range/)
    })

    // --- a single-frame GIF is answered, not rejected -----------------------
    console.log('\nedge cases:')
    await check('a still GIF returns its one frame and says it is not animated', async () => {
      const result = await run({ file_path: join(FIXTURES, 'still.gif') })
      assert.equal(result.isError, false, textOf(result))
      assert.equal(imagesOf(result).length, 1)
      assert.match(result.content[0].text, /not animated/)
    })

    // --- animated WebP rides the same path ---------------------------------
    console.log('\nanimated WebP:')
    await check('an animated WebP yields frames too', async () => {
      const result = await run({ file_path: join(FIXTURES, 'moving.webp'), max_frames: 3 })
      assert.equal(result.isError, false, textOf(result))
      assert.equal(imagesOf(result).length, 3)
      assert.match(result.content[0].text, /image\/webp animation/)
    })

    // --- a model route without image input is refused -----------------------
    await check('a text-only route is refused with an actionable message', async () => {
      inputModalities = ['text']
      try {
        const result = await run({ file_path: join(FIXTURES, 'moving-8f.gif') })
        assert.equal(result.isError, true)
        assert.match(textOf(result), /does not declare image input/)
      } finally {
        inputModalities = ['text', 'image']
      }
    })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(scratch, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exit(1)
}

await main()
