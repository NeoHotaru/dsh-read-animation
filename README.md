# dsh-read-animation

A DeepSeek Harness plugin that lets the agent **actually see an animated GIF**.

`read_image` on a GIF gives the model one picture — the first frame — and no
signal that the other frames existed. This plugin decodes every frame and hands
the model a labelled sequence of real frames sampled across the animation's
timeline.

```sh
dsh plugin --profile web add dsh-read-animation
```

---

## The problem

DeepSeek Harness normalizes every stored image to a single-frame 8-bit sRGB
raster before it reaches a model, and it does this to animations too.
`@deepseek-ai/dsh-attachment-local` excludes `image/gif` from its pass-through
path and re-encodes through a pipeline that never sets `animated` or `page`, so
`sharp` returns page 0 and the rest are dropped on the floor.

Measured, on this machine, against an 8-frame GIF:

```
metadata:  {"format":"gif","width":240,"height":160,"pages":8,
            "delay":[80,80,80,80,80,80,80,80],"loop":0}
default -> 240x160  pages=1     ← what read_image delivers
animated -> 240x1280 pages=1    ← all eight frames, when asked for
```

No layer above the read step can repair this. By the time a vision plugin, an
image router, or the LLM adapter sees the image it is already a single frame —
which is why the growing ecosystem of DSH vision plugins
([`dsh-multimodal`](https://github.com/SCT192221/dsh-multimodal),
[`dsh-mmroute`](https://github.com/jmxsxwyzjdwl/dsh-mmroute),
[`dsh-vision-mix`](https://github.com/haiziyao/dsh-vision-mix),
[`dsh-tool-plus`](https://github.com/xiaoso456/dsh-tool-plus), …) all say they
"support PNG/JPEG/WebP/GIF" without any of them showing you motion. The
animation is still intact in exactly one place: the file. So the tool lives
there.

Animated PNG has the same disease with a worse prognosis: libvips 8.18.7 does
not read `acTL`/`fcTL`/`fdAT` at all, reports an APNG as a one-page PNG, and
silently discards every frame after the first. This plugin detects that case from
the chunk stream and refuses it by name instead of returning frame 0.

## Two ways in, both handled

**Pasting into the chat box.** That path is already clean on the browser side: the
paste handler hands the clipboard's own `File` straight to the upload path, and
that path encodes `image/gif` and `image/webp` unchanged (`imageMediaType()`
accepts both and returns them as-is) — no canvas, no `drawImage`, no `toBlob`.
**The bytes reach the Host whole.** It is the Host that destroys them:
`admitPromptContent` runs every image through the single-frame normalizer and
keeps no copy of the source.

`admitPromptContent` is therefore the last moment the original bytes exist. The
plugin wraps it, decodes the animation and stores the frames — then **returns the
original result untouched**:

```
you paste 1 animation
   ├─ the message: unchanged — the picture you sent, not one word added
   ├─ the UI: the animation itself, played from the original bytes
   └─ the model: one sheet of its frames, each labelled with index and time
```

**What you send is what you send.** Nothing is added to the message you wrote,
and it does not turn into eight stills.

**And it keeps playing in the UI.** The Web UI has exactly one way to display a
durable image: `session.readAttachment(id)` → the Host's
`ctx.attachments.readImage(ref)` →
`URL.createObjectURL(new Blob([bytes], { type: attachment.mediaType }))`. Both the
bytes and the media type come from that one host call, and the browser animates
whatever it is handed. So the plugin serves the original at that **display read** —
no client plugin, no media route, no second authorization path. The single frame
in the store is only a lossy artifact of a normalizer that cannot represent
motion; handing back the file the person actually pasted is the more truthful
answer to "read this stored image", and the other two callers of that layer (ACP
image blocks, session-log export) are better with an animation too.

Each captured frame carries its index and start time in its attachment display
name (`x.gif#frame16@1960ms`), which the harness renders to the model as
`Image "<name>" …` — so the timing is already attached to the frames, waiting
for the delivery step below.

**The display path and the model's are independent**: the UI is served the
original bytes by `readImage`, while the model's copy comes from
`readImageRequest`, which composes the sheet.

> **Where the frames are delivered**: `readImageRequest(ref, target, signal)` is
> the method each adapter calls to build its own copy of one image
> (`dsh-llm-deepseek` and `dsh-llm-pi-ai` both do), so it is the seam that reaches
> the model. It answers with exactly one image, so the frames are composed into one
> labelled sheet: a 4x2 grid for eight samples of a phone-shaped animation, every
> tile at its native size, with the frame index, duration and start time printed
> under each. Nothing is re-derived per request — the same stored attachment always
> produces the same sheet — and the sheet is built once and cached.
>
> The route that looks obvious, rewriting the request from an `llm/stream`
> listener, is closed by design: a loop-built request "arrives deep-frozen
> (mutation throws): its content is a pure function of the session log", so
> listeners may read it but never rewrite it. An earlier version of this plugin
> tried exactly that and silently did nothing, because the probe behind it used a
> hand-built request, which is the one case that documentation exempts.

**Files.** Animations in the workspace, or attached as files, still exist on
disk byte-for-byte; the `read_animation` tool below reads those.

## What it does

`read_animation(path, …)` returns one text header plus one captioned image per
sampled frame:

```
<path>D:\work\dance.gif</path>
<type>animation</type>
<content>
image/gif animation, 480x270 px, 24 frames, 1200 ms total, ~20 fps, loops forever.
Attached below are 6 frames sampled evenly in time from this animation. They are
consecutive moments of the SAME animation, in time order, not separate images;
each is preceded by its frame index and start time.
Only frames 0, 4, 9, 13, 18, 23 of 24 were sampled, so any motion between two
attached frames is not visible. Re-read with explicit "frames" indices to inspect
a specific moment, or a higher "max_frames" to sample more densely.
</content>
```

…then, for each frame:

```
frame 9 of 24 (sample 3) · starts at 450 ms · displayed for 50 ms
[ image ]
```

Everything the model needs to reason about *motion* is in that text: how long the
animation runs, how fast it plays, whether it loops, which frames it is looking
at, and — stated outright, because it is the easiest thing to get wrong — that
the gaps are gaps.

## Install

```sh
dsh plugin --profile web add dsh-read-animation
```

Replace `web` with your profile name. **Not on npm yet** — until it is, install
straight from the repository:

```sh
dsh plugin --profile web add github:NeoHotaru/dsh-read-animation
```

That route is verified end to end: it installs, `dsh plugin add` registers the
bundle, and the `sharp` native binary resolves from the package's own
`node_modules`. (A git spec copies the whole repository, tests and fixtures
included, which is why the npm package above is the nicer install once it
exists.)

Or from a checkout:

```sh
cd dsh-read-animation
npm install                                     # fetches sharp
dsh plugin --profile web add link:$PWD
```

The same spec works in the Web sidebar's Plugins page, and in Settings the plugin
list is read-only. Restart the running instance afterwards: plugin rows take
effect on the next process, and a `link:`ed checkout is loaded once at startup.

## Usage

The model reaches for it on its own for a `.gif`, because the tool description
says to. You can also ask directly:

> what happens in this GIF? — `animations/loading-spinner.gif`

Arguments:

| argument | meaning |
|---|---|
| `file_path` | the animation to read (required) |
| `frames` | explicit 0-based indices, in the order given — up to 16 |
| `at` | millisecond instants to sample instead of an even spread |
| `max_frames` | how many frames to sample (default 8, maximum 16) |
| `max_edge` | long-edge size of each returned frame in px (default 640) |

A useful loop, when the first read is not enough detail:

```
read_animation { file_path: "dance.gif" }              → 8 frames across the timeline
read_animation { file_path: "dance.gif",
                 frames: [11, 12, 13], max_edge: 1024 } → those three, full size
```

## Configuration

Optional, in the plugin row of your profile's `cordis.patch.yml`:

```yaml
- id: read-animation
  name: 'dsh-read-animation'
  config:
    maxFrames: 8          # default frames per call, 1..16
    maxEdge: 640          # default long-edge cap, 64..2048
    background: white     # "white" flattens transparency, "keep" preserves it
    maxInputBytes: 67108864   # refuse animations larger than this
    expandPastedAnimations: true   # a pasted animation keeps playing in the UI and reaches the model as a frame sheet
```

## What it will not do

- **Video.** MP4/WebM need ffmpeg and a different decode path. Use
  [`dsh-video-tools`](https://github.com/PiedPiper911/dsh-video-tools).
- **APNG.** Not decodable by the host image library; refused with an explanation
  (see above).
- **Read a static image.** It says so and points at `read_image`. A single-frame
  GIF or WebP is answered, with a note that it is not animated.
- **Guess.** When the sampler returns fewer frames than you asked for, the header
  says which ones and why.

## How it behaves under the hood

Frames are committed through `ctx.attachments.saveImages`, the same store every
other harness image goes through. So frames are content-addressed (two identical
frames in one GIF cost one attachment; re-reading a file reuses what is already
stored), durable across a session replay, and subject to the deployment's own
image limits. Frames are resized to the target edge and re-encoded as PNG before
storage, so the harness's normalizer has nothing left to do to them.

Reading goes through `ctx.fs.readBytes` and emits `fs/observed`, so the sandbox
and the read-before-write policy apply exactly as they do to `read_image`. The
tool refuses to run when the resolved model route does not declare image input,
for the same reason `read_image` does.

**A pasted animation** is handled in three steps, none of which touch your
message: **capture** at admission (`ctx.attachments.admitPromptContent` is the last
moment the original bytes exist), **display** at `ctx.attachments.readImage` (the
one read the UI makes, served the original so it plays), and **delivery** at
`ctx.attachments.readImageRequest` (the model's copy, composed into one labelled
sheet). All three are **monkey-patches of core service methods**, so they do
nothing at all the moment anything is not as expected — a missing method, a failed
assignment, a decode that throws, an original that cannot be read back, a batch
with no room. The caller always receives exactly what it would have received
anyway. Captured frames and the original file are recorded in
`$DSH_HOME/read-animation/v1/pasted.jsonl`, keyed by the attachment id the message
carries, so a session resumed in a new process still displays — and still expands
— an animation pasted before the restart. Delivery swaps references only — at that
layer an image is still `{type: 'image', attachment}` — and never touches bytes.

### Design notes for contributors

Two decisions are worth knowing before you change anything.

**Frames are extracted one at a time with `sharp(buf, { page: i })`, not by
decoding the animation as one tall strip and slicing it.** Both were measured on
a 600×400, 60-frame GIF: the strip path costs 54.9 MiB resident and is *slower*
here (228 ms for 8 frames at a 512 px target, because it resizes all 60 frames)
than per-frame extraction (182 ms, one frame resident at a time). The correctness
claim this rests on — that `{ page: i }` is byte-identical to frame `i` of the
composited strip — is pinned by a test.

**The package imports no `@deepseek-ai/*` at runtime.** The harness's own tools
build their definitions with `defineTool`, which compiles a schema spec and wraps
the body with argument validation. That is right for a plugin installed *as a
package*, where pnpm places it under `$DSH_HOME/profiles/<name>/node_modules/`
and `@deepseek-ai/*` resolves by walking up to the profile's hoisted tree. It is
wrong for a plugin *linked from a working copy*: a `link:`ed package loads
through its real path, so its imports resolve upward from the checkout, where no
`@deepseek-ai/*` exists — measured, by importing the entry with `node_modules`
absent (`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`).
`lib/tool.js` therefore ships the compiled JSON Schema as literals beside the
authoring spec, and the integration harness asserts the real `defineTool` still
derives exactly those literals from that spec. Edit the spec, run
`npm run derive-schema`, paste the result.

## Development

```sh
npm install
npm test                 # decoder, sampling, envelope, and argument validation
npm run test:integration # real dsh-fs, dsh-attachments, and dsh-tools, in-process
npm run fixtures         # regenerate test/fixtures (needs Python 3 + Pillow)
```

`npm test` needs nothing but Node and the installed `sharp`.

`npm run test:integration` boots the genuine `dsh-fs-local`,
`dsh-attachment-local`, `dsh-system-prompt`, and `dsh-tools` plugins in-process,
registers the tool, and executes it. It exists to prove the one thing no unit
test can reach and the whole design depends on: that a single tool result
carrying *several* image blocks survives the real registry and the real
attachment store. Only the `llm` service and the agent object are stubbed, both
because they need a live model session. Point it at your harness install:

```sh
DSH_HARNESS_MODULES="$(npm root -g)/@deepseek-ai/dsh/node_modules" npm run test:integration
```

On a machine that has no `sharp` reachable from the checkout,
`DSH_READ_ANIMATION_SHARP=<path to a loadable sharp>` overrides resolution.

The fixtures are committed, so the suite runs without Python; `make-fixtures.py`
regenerates them and documents what each one is for.

## License

MIT. See [THIRD_PARTY.md](THIRD_PARTY.md) for sharp and libvips.
