# Third-party components

## Runtime dependency

### sharp (`^0.35.5`) — Apache License 2.0

<https://github.com/lovell/sharp>

Used to decode animations and encode frame images. sharp ships prebuilt
platform binaries as optional dependencies (`@img/sharp-<platform>`); the
install step fetches the one matching the host.

sharp itself links against **libvips**, distributed as
`@img/sharp-libvips-<platform>` under the **GNU Lesser General Public License
v3.0**. The bundled libvips build used here is
`@img/sharp-libvips-win32-x64`; on other platforms the matching package applies.
LGPL obligations attach to libvips, not to this package: it is used as an
unmodified shared library loaded at runtime, and its source is available from
the links above.

This package additionally relies on the following libvips loaders, each with its
own licence upstream:

- **cgif** (GIF encode) — MIT
- **libnsgif** (GIF decode) — MIT
- **libwebp** (WebP decode) — BSD-3-Clause

## Development-time only

The integration harness imports packages from a local DeepSeek Harness
installation (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-fs-local`, `@deepseek-ai/dsh-attachment-local`,
`@deepseek-ai/dsh-system-prompt`). They are **not** dependencies of the
published package and are not loaded at runtime — see the module comment in
`lib/tool.js` for why. DeepSeek Harness is MIT licensed.
