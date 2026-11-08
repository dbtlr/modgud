# Install or update Modgud in user scope

This guide describes the Linux x64 version 0.1.0 prerelease.
Use the reviewed release assets and their checksums for installation.

## Install a pinned binary

Obtain `packages/modgud/install.sh` from the reviewed source archive.
Run the installer as the account that runs Modgud:

```sh
sh packages/modgud/install.sh 0.1.0
"$HOME/.local/bin/modgud" --version
```

Expected version: `modgud v0.1.0`.
The installer fetches `modgud-linux-x64` and `SHA256SUMS` from
`https://github.com/dbtlr/modgud/releases/download/v0.1.0/` on Linux x64 with glibc.
It also downloads `modgud-NOTICES.txt` and verifies both files against SHA256SUMS before activation.
Full notices accompany the executable as `modgud.NOTICES.txt` in the same directory.
It stages both downloads before installing notices and renaming the executable in the destination directory.
A failed binary or notice download or checksum preserves the installed executable and notices.
If the final executable rename fails, the installer restores the previous notices.
If that recovery also fails, the error identifies the retained recovery file.
It records binary installation under the application's state directory.
It does not create configuration, migrate stores, or manage the Service or tunnel.
An explicit version is mandatory. Repeating the command installs that pinned version again.
Use `--dir /absolute/bin` when the Application's configured binary directory differs.

## Converge the native user service

Before first adoption, remove the existing unit from its previous owner's declaration through a reviewed change.
Do not let two owners manage `com.dbtlr.modgud.service`.
With default private configuration already provisioned for the service account, run:

```sh
"$HOME/.local/bin/modgud" service install
"$HOME/.local/bin/modgud" service restart
"$HOME/.local/bin/modgud" service status
```

`service install` writes the native user unit, reloads systemd, enables it, and restarts it.
Its executable path is absolute. Its working directory is the account's home.
The Service reads `~/.config/modgud/modgud.toml` without an override.
The default store is `~/.local/state/modgud/modgud.sqlite`.
Set absolute backend executable paths in configuration, or supply the backend's PATH through its Service `env`.
The user manager's minimal PATH does not discover binaries in `~/.local/bin` automatically.
Preserve configuration, harness settings, store path, issuer, resource URIs, and tunnel routing during adoption.
Do not use `pair` or `revoke` as lifecycle hooks.

`status` exits zero when it reports a state, including a stopped state.
A Fleet health check must inspect the reported state and verify application behavior.
There is no `service logs` command. Read the native JSONL log:

```sh
tail -n 100 "${XDG_STATE_HOME:-$HOME/.local/state}/modgud/modgud.jsonl"
```

The log rotates at 10 MB and keeps five copies.
Real manager activation, user-session persistence, and actual-client continuity require later live validation.

## Recover from a failed update

A download or checksum failure needs no binary recovery. Correct the cause and rerun the pinned installer.
If the installed binary fails validation, retain the private store and stop the rollout.
Restore a previously reviewed executable and its accompanying notices through a checksum-verified pinned installer, then converge the native Service.
An executable rollback is not a claim that production state can roll back safely.
The tested backward case uses a separate consistent copy of synthetic post-candidate state.
Do not delete, reset, or replace the OAuth store to repair an installer failure.
`service uninstall` removes the service definition and stops it. It preserves application configuration and the store.

## Distribution files

Modgud registers no self-update plugin. Rerun the verified pinned installer for updates.
Raw assets are retained for Loom release metadata compatibility. A raw executable alone is not the supported distribution.
Manual extraction uses the runtime archive, retaining its LICENSE and notices directory beside the executable.
The notice asset includes application, npm, Bun component, and relinking notices.
Distribute the version-matched rebuild-input archive with the runtime and source archives.
That archive contains pinned sources and build recipes, not a promise of future source hosting.

## Package a committed source revision

Use a Git checkout whose HEAD is the intended release revision:

```sh
python3 release/package.py --source /absolute/source-checkout --binary /absolute/modgud --notices /absolute/reviewed-notices --out /absolute/empty-output
```

The source archive reads committed Git objects at HEAD. Uncommitted edits, ignored files, and untracked local state are excluded.
Symlinks and submodules in source, and symlinks in the notice input, are rejected.
The notice directory is an explicit distribution input; supply only reviewed notices.
Archive names follow the committed package version. Both provenance files record the selected source commit and the supplied executable's checksum.
These records identify packaging inputs; they do not prove that the supplied executable was built from that commit.
The packager does not generate or claim a source diff. A separately reviewed release may attach one.
