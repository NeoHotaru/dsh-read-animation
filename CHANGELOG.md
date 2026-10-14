# Changelog

## 0.1.1 — 2026-10-14

Fixed after the first release, from what a live session reported back.

- **`read_animation` follows the path it advertises.** Every image a model receives
  is shown as a normalized copy at `attachments/v1/objects/<2>/<digest>`, and that
  is the path a model reaches for when it wants to look at the picture again. For a
  pasted animation that copy is a single frame, so the tool answered "this picture
  has one frame": true of that file, and useless as an answer. The tool now resolves
  that path to the animation this plugin kept, and reports the file the bytes
  actually came from. A bare `sha256:<digest>` is accepted too.
- **The sheet says where the animation lives.** Its header ends with the path the
  store keeps the original at, so a model that wants more than the eight samples can
  read that path with explicit frame indices instead of searching the attachment
  store for the file behind the picture it was sent.

## 0.1.0 — 2026-10-14

First release.

Note for anyone publishing a later version, because both releases so far looked like
failures while they were simply still in flight:

- `npm publish` answers `PUT … 202` and prints "Your package is being processed and
  may take a few minutes to become available", then exits 0. For a brand-new package
  name the registry also carries a public `0.0.0-stage` placeholder alongside it.
  Nothing needs approving in either case.
- Measured on 0.1.1: the version appeared in the packument **2m41s** after the PUT,
  and its tarball became downloadable **7m05s** after it. In between, the packument
  either 404s or lists the version while its tarball still 404s.
- Check the tarball, not just `npm view versions`, and check it with a GET: a HEAD
  request to the tarball URL answers 404 even once the tarball is live.
- A mirror lags further. `registry.npmmirror.com` still served 0.1.0 well after
  0.1.1 was live on npmjs.org, and a profile configured against it keeps installing
  the previous version until it syncs.

### Fixed after an adversarial audit

Four independent reviews (blast radius, plugin code, packaging and lifecycle, then
an adversarial pass over every high-severity finding) ran before this was
published. What they found, and what changed:

- **The frame sheet's `variantId` was not a content digest.** It was a hand-rolled
  `sha256:filmanim…` string, and the DeepSeek adapter validates persisted ids
  against `/^sha256:[0-9a-f]{64}$/` when it loads its upload index — then swallows
  the failure into an *empty* index. The effect was not a visible error: it
  discarded every other session's cached file id and re-uploaded every image.
  Reproduced against the real exported index class (plugin id: written 1, reloaded
  0; conforming id: 1/1). It is now the SHA-256 of the bytes being returned, which
  also stops one on-disk cache entry from aliasing two different byte streams.
- **The degraded path was worse than the missing feature.** The store reaches the
  frame it re-encodes through its own `readImage` call, which this plugin wraps, so
  falling back to the store's request read could hand the model the *whole
  animation* where it expects one frame. The request path now suspends the
  animation substitution around that call, and reads its own tiles through the
  unwrapped read. Pinned by an integration check that breaks a stored frame and
  asserts the fallback is exactly one frame.
- **No decoded-pixel ceiling on the `read_animation` path.** `limitInputPixels`
  was disabled with nothing in its place: a 60 KB file declaring a 9000x9000
  canvas was refused by the deployment's own attachment store and decoded here
  anyway, at about 310 MiB. Both the probe and the frame extraction now carry the
  deployment's `imageLimits.maxImagePixels`.
- **The sheet cache ignored the size the caller asked for**, so a caller with an
  8 KiB budget could be served a 28 KB sheet built for a 4 MiB one. The target is
  now part of the cache key, and a tile is never larger than a single frame would
  have been for that caller.
- **The measured header wrap could still be defeated.** A floor of 16 characters
  kept the loop from reaching a budget that fit, so on a narrow canvas it gave up
  and returned ink wider than the sheet. The floor is now low enough to be
  satisfiable, and a canvas too narrow for legible text gets no header at all.
- **The canvas was composed before it was shrunk**, building a 6156x6306 (about
  111 MiB) image to throw away. Tile size and grid are settled first.
- **Torn state files could poison the next record.** A crash part way through an
  append left a line with no newline, so the following record concatenated onto it
  and became unreadable too. A torn tail is now detected and compacted away.
- **The store's bound applied to memory but not to what was read back**, and the
  log was never compacted. Both fixed; the file is rewritten when it grows past
  twice the entries worth keeping.
- **Teardown was last-writer-wins.** Each install captured whatever was on the
  method, so disposing one left another's patch removed and could reinstall a
  disposed closure as a permanent own property. Three wrappers now share one
  installer that resolves its delegate per call, removes cleanly (deleting an
  inherited property rather than leaving a shadow behind), and reports whether it
  actually took effect — the previous identity check compared a value that proxy
  reads always re-wrap, so it could never detect a failed install.
- **`npm test` did not run the invariant checks.** The no-`@deepseek-ai`-import
  rule and the bundle/manifest consistency check lived only in the integration
  harness, which prints SKIP and exits 0 without `DSH_HARNESS_MODULES`. Both now
  run in `npm test`, which is also the `prepublishOnly` gate.
- **`files[]` omitted `scripts/`** while `package.json` advertised two npm scripts
  that live there, so the published package's own scripts were broken.

- **A pasted animation keeps playing in the UI, and the message is left alone.**
  The browser already uploads an animated GIF/WebP byte-for-byte and labelled as
  such; the Host flattens it to a single
  frame during prompt admission and keeps no copy of the source. The plugin wraps
  `ctx.attachments.admitPromptContent` to capture the frames and the original file
  at that moment, and `ctx.attachments.readImage` so the UI is served the animation
  itself (the browser animates whatever bytes that one read returns). What you send
  is what you send: the chat message is unchanged.
- **The model now receives a labelled sheet of the frames.** The delivery step is
  `ctx.attachments.readImageRequest(ref, target, signal)`, the method each adapter
  calls to build its own copy of one image. It answers with exactly one image, so
  the frames are composed into a grid chosen to be as square as the sheet budget
  allows — every tile at its native size, with the frame index, duration and start
  time printed under each, and the animation's own facts in a wrapped header. The
  sheet is built once per animation and cached.
- Rewriting the request from an `llm/stream` listener is **not** used and would not
  work: a loop-built request arrives deep-frozen ("listeners read it, never rewrite
  it"), so that earlier attempt silently did nothing.
- Captured frames and the original are persisted per `$DSH_HOME` in
  `read-animation/v1/pasted.jsonl`, keyed by the message's attachment id, so a
  session resumed in a new process still displays — and still delivers — an
  animation pasted before the restart.
- A frame's index and start time ride in its attachment display name
  (`x.gif#frame16@1960ms`), which the harness renders beside the picture once the
  frames are delivered — so the timing never has to be repeated as message text.
  (An earlier version of this feature put a header plus one caption per frame into
  the user's own message; consecutive text parts are concatenated by the UI with
  no separator, so a one-image message became an unreadable wall.)
- `read_animation` tool: decodes an animated GIF or animated WebP, samples frames
  across the timeline (or by explicit index / instant), commits each frame to the
  attachment store, and returns a header plus one captioned image per frame.
- Refuses animated PNG by name instead of silently returning its first frame,
  which is what the host image library does with one.
- Refuses static images and points at `read_image`; answers a single-frame GIF or
  WebP with a note that it is not animated.
- Discloses decode-time substitutions in the model-facing text: zero frame
  delays treated as 100 ms, missing delays, transparency flattened onto white.
- The package imports no `@deepseek-ai/*` module at runtime, so it loads both as
  an installed package and as a `link:`ed checkout. The compiled schemas ship as
  literals beside their authoring specs, and the integration harness keeps the
  two in step.
