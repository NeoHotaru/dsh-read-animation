# Changelog

## 0.1.0 — unreleased

Initial version.

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
