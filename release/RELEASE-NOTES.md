# Modgud 0.1.0 prerelease

This initial Linux x64 release packages Modgud's native user-service lifecycle with a version-pinned, checksum-verified installer.
The installer delivers runtime notices before replacing the executable. Supported updates rerun that installer and converge the native Service.

Each Grant shares one Child across its Sessions. The native Service identity remains `com.dbtlr.modgud`.
Use `public.max_sessions_per_grant`; the retired `public.max_sessions` setting is ignored with a warning.
Core authorization/session algorithms, store schema, issuer/resource semantics and locked dependency versions are unchanged from the selected source baseline.
MCP client metadata follows the package version. Test helpers isolate platform logs and verify both immediate and asynchronous spawn failure.

Validation includes the full Linux and macOS suites, installer failure/preservation tests, native interfaces and 59 synthetic cross-version OAuth checks on the released executable.
The notice/rebuild bundle supplies pinned runtime/library sources and an exercised recipient-supplied runtime compilation route.
A modified WebKit build was not performed.

Actual paired-client continuity, native manager activation and ownership transfer require separately reviewed deployment verification.
Linux x64 with glibc is the supplied release target. Obtain the executable and its accompanying notices and rebuild inputs together.
