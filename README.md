# Modgud

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Modgud is an MCP auth proxy. It runs local stdio MCP servers, one child process per MCP session, and serves them as Streamable HTTP MCP endpoints that a tunnel such as Cloudflare Tunnel can expose. Modgud is its own OAuth 2.1 authorization server, so chat clients such as Claude and ChatGPT can connect. It maps every caller to a Grant, which sets the target service, the expiry, the tool allow and deny selectors, and the identity that Modgud passes to the tool.

Status: in build. `modgud serve` serves stdio MCP servers over Streamable HTTP behind one static bearer token. The OAuth server and Grants are not built yet.

## Running Modgud

`modgud serve` reads `~/.config/modgud/modgud.toml`, or the file that `--config` or `MODGUD_CONFIG` names. It serves each configured Service at `/<service>/mcp` on the Public listener until it receives SIGTERM or SIGINT. On shutdown it ends every Session and stops every Child.

```toml
[harness]
# The SHA-256 hash of the bearer token, in lowercase hex. Callers send the token
# itself as `Authorization: Bearer <token>`.
bearer_token_sha256 = "…"

[public]
host = "127.0.0.1"    # default
port = 8470           # default
max_sessions = 16     # default; an initialize past it gets HTTP 503
allowed_origins = []  # default; a request with any other Origin header gets HTTP 403

[services.norn]
command = "norn"
args = ["mcp", "-C", "/path/to/vault"]
cwd = "/path/to/vault"        # optional
env = { NORN_ROOT = "/path/to/vault" }  # optional
idle_timeout_minutes = 30     # default
# identity_env = "MIMIR_USER" # optional; reserved for the Grant's Identity
```

To make a token and its hash:

```sh
token=$(openssl rand -hex 32)
printf '%s' "$token" | sha256sum
```

Each Session gets its own Child process. The Child's environment holds only `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `TMPDIR`, `TZ`, and `USER` from Modgud's own environment, plus the Service's `env`. A Session ends when the Caller deletes it, when it is idle for the Service's timeout, or when its Child exits.

To measure what Modgud adds to a tool call, compared with calling the Service directly over stdio:

```sh
bun packages/modgud/scripts/bench-overhead.ts --tool vault.count -- norn mcp -C /path/to/vault
```

## Plan

Modgud is built in four phases:

- Phase 1, crux test: Norn served over Streamable HTTP, then the OAuth server proven with claude.ai and ChatGPT.
- Phase 2, Grants: the Grant store, Selectors, revocation, the admin API and CLI, and the audit log.
- Phase 3, Identity: Mimir served with the Grant's Identity.
- Phase 4, admin panel: tailnet pages for Grants, pairing, live Sessions, and the audit log.
