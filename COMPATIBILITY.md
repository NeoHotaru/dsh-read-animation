# Compatibility

## Supported range

**DSH 0.1.3-alpha.2 and later.** Verified as of 2026-10-14, against DSH
0.2.1-alpha.3 (the newest release at that time).

## What was measured

### The integration suite, actually run

`test/integration/harness.mjs` boots the real `dsh-fs-local`,
`dsh-attachment-local`, `dsh-system-prompt` and `dsh-tools` plugins in-process,
registers the tool, and exercises the paste path through a real `llm.stream`
dispatch. Pointed at four versions spanning the range:

| DSH | checks |
| --- | --- |
| `0.1.3-alpha.2` — the oldest release with the full API | 38/38 |
| `0.1.7-alpha.2` — the version this was developed against | 38/38 |
| `0.2.0-rc.2` — `latest` on that date | 38/38 |
| `0.2.1-alpha.3` — `alpha` on that date, newest | 38/38 |

```sh
DSH_HARNESS_MODULES=/path/to/dsh/node_modules node test/integration/harness.mjs
```

### The API surface, read from every published release

`scripts/check-dsh-compat.py` downloads the type declarations of
`@deepseek-ai/dsh-attachment` and `@deepseek-ai/dsh-attachment-local` for every
published DSH version and reports which of the members this plugin calls are
present. DSH publishes its whole monorepo at one version, so `dsh@X` pins
`dsh-attachment-local@X`.

```sh
python scripts/check-dsh-compat.py
```

The result over all 32 published releases: every member is present from
**0.1.3-alpha.2** onward and absent before it. The members, and the release each
first appears in:

| member | since |
| --- | --- |
| `saveImages` | `0.1.0-rc.7` |
| `admitPromptContent` | `0.1.2-alpha.2` |
| `readImageRequest` | `0.1.2-alpha.3` |
| `readFileStream` | `0.1.2-alpha.3` |
| `saveFile` | `0.1.3-alpha.2` |
| `fileHostPath` | `0.1.3-alpha.2` — optional; the plugin works without it |

So the floor is set by `saveFile`, which is what keeps the original animation's
bytes for the sheet, and by `fileHostPath`. Below `0.1.3-alpha.2` the plugin still
mounts and still reads animations from files; pasted animations degrade to a
single frame, and it says which member is missing and when that member arrived.

## What is not claimed

- **Four of the seventeen releases in the range were executed.** Every release in
  the range was checked to expose the full member list, but a release whose types
  are complete can still behave differently. The four points span floor to ceiling.
- **The upper bound is a date, not a guarantee.** This plugin wraps
  `admitPromptContent`, `readImage`, and `readImageRequest` — internal service
  methods. A DSH release that changes their signatures or the shape of a request
  target will break it, and nothing here can detect that in advance.
- **The `engines.dsh` field is documentation.** npm does not enforce a
  non-standard `engines` key, and DSH does not read it. It records the measured
  floor; it does not stop an install.

## Re-measuring after a DSH release

1. `python scripts/check-dsh-compat.py` — does the new release still expose
   everything?
2. Install it somewhere and run the suite against it:

   ```sh
   mkdir /tmp/dsh-probe && cd /tmp/dsh-probe
   npm init -y && npm i @deepseek-ai/dsh@<version>
   cd <this repo>
   DSH_HARNESS_MODULES=/tmp/dsh-probe/node_modules node test/integration/harness.mjs
   ```

3. If it fails, the check that fails names the method. The messages raised at mount
   and from the tool also name the missing member and the release it arrived in.
