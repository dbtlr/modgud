# Rebuild Modgud with a replacement Bun runtime

The application remains MIT-licensed. Recipients may replace or modify the bundled runtime and rebuild this application.
No application restriction forbids reverse engineering to debug library modifications.

Bun is pinned to commit `38afee6c84fcf48c0edb2466aa4b27d287a59c30` (1.4.4).
Its build recipe pins WebKit to `d6375c72affe0f70222cdcb45012b10f0bf3a9d5`.
The rebuild-input archive contains the supplied source archives, Cargo.lock-verified crates, component inventory, and upstream build recipes.
Use the component manifest and SHA256SUMS to verify these inputs.

Follow Bun's pinned LICENSE.md and CONTRIBUTING.md to build the runtime.
The upstream route runs `bun sync-webkit-source`, then `bun run build:local`.
These commands rebuild JavaScriptCore and Bun's bindings instead of substituting a prebuilt WebKit.
The pinned build recipe is `scripts/build/deps/webkit.ts` in the Bun source archive.
Use its local build mode and the pinned WebKit sources when modifying the library.
Bun's upstream build also needs its documented compiler, SDK, system libraries, and build tools.
The supplied inputs do not include every platform SDK or compiler binary.

With the source archive extracted and locked application dependencies installed, run:

```sh
bun install --frozen-lockfile
python3 release/relink.py --runtime /absolute/path/to/rebuilt/bun --out /absolute/path/to/modgud
```

`relink.py` obtains canonical release facts from locked Loom 0.18.0 using its documented `--define` interface.
It passes those facts to Bun's `--compile-executable-path` interface without modifying Loom or application behavior.
The ordinary release build remains `bun run build`.

The supplied-runtime route was exercised with an unmodified Bun 1.4.4 Linux executable and the resulting executable reports `modgud v0.1.0`.
This proves the compiler accepts a local replacement runtime. It does not prove a modified WebKit build succeeded.
No full WebKit compilation was run during candidate preparation.

Upstream references:

- [Pinned Bun license and build route](https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md)
- [Bun compiler options](https://bun.com/docs/bundler)

The release uses ICU 78.3 from WebKit `icu/source.json`, with the icu/ data-repacking recipes and patch.
These are supplied with shell/ and .github/ release build scripts. The 74.2 headers in Source/WTF/icu are compatibility headers, not the release ICU source pin.
