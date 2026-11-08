# Runtime notice coverage

The app retains its MIT license unchanged. The installer includes the MIT attribution for its Loom 0.18.0 derivation.

`app-runtime-closure.json` records ten packages reachable through production dependency declarations.
`bundled-npm-modules.json` records the six packages with modules in the actual compiled application graph.
The other four declaration dependencies contribute no modules to that graph.
The complete npm notice collection retains full licenses, copyrights, and Loom's additional attribution files.
The broad 109-package collection includes build tools. Eleven build-only tarballs omit notice files.
Those omissions do not establish a gap in the six-package distributed application graph.
No dependency version or integrity was changed.

The executable also contains Bun 1.4.4, revision `38afee6c8`.
The Bun audit is separate from the npm graph. Bun's own LICENSE.md enumerates linked libraries and embedded components.
`bun-components.json` records native dependency revisions and archive checksums read from pinned Bun build recipes.
The rebuild-input archive retains Bun sources, collected native dependency archives, and all 180 Cargo.lock registry archives verified against lock checksums.
Full collected license files and source copyright headers accompany those inputs.
Windows-only libuv sources are retained conservatively, although this candidate targets Linux x64.
Bun-vendored uSockets, uWebSockets, polyfill files, and attribution remain in the pinned Bun source archive.
WebKit supplies additional LGPL, ICU, and simdutf material. The companion rebuild-input archive records exact source coverage and checksums in its manifest and `webkit-coverage.json`.

`RELINKING.md` documents the pinned upstream build route and an exercised recipient-supplied runtime compilation route.
A modified WebKit build has not been performed. No blanket legal certification or future source-hosting commitment is asserted.

The verified installer downloads `modgud-NOTICES.txt` before activation and installs it beside the executable as `modgud.NOTICES.txt`.
Binary or notice download and checksum failures preserve the old executable and old notices.
The runtime archive also contains the complete notice collection.
Modgud registers no self-update plugin. Supported updates rerun the verified installer, then converge the native Service.
Raw executable assets remain available for release metadata compatibility and must travel with their notices and rebuild inputs.

The supplied sources, notices, and manifests provide concrete technical coverage evidence.
They do not claim an independently completed modified-library build.

The retained WebKit archive contains the pinned JSCOnly library trees and all Tools, with original symlinks preserved.
`webkit-coverage.json` lists exact included paths and the archive checksum.
ICU and simdutf notices are retained from that tree at `Source/WTF/icu/LICENSE` and `Source/WTF/wtf/simdutf/LICENSE-simdutf.txt`.
JavaScriptCore COPYING.LIB and the LGPL texts for Bun's WebCore-derived code are retained.
Bun's in-tree SQLite amalgamation, library bindings, uSockets, and uWebSockets are in the Bun source archive.
No build of the modified library, or independent reproduction of Bun's upstream release binary, is claimed.

The release ICU is 78.3, pinned separately in WebKit `icu/source.json`; the vendored compatibility headers are 74.2.
ICU 78.3 sources match upstream pin SHA-256 `3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0`.
Its full license files accompany the runtime notices. WebKit icu/, shell/, and .github/ release scripts and patches accompany the rebuild sources.
