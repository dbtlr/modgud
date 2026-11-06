# Modgud

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Modgud is an MCP auth proxy. It runs local stdio MCP servers, one child process per MCP session, and serves them as Streamable HTTP MCP endpoints that a tunnel such as Cloudflare Tunnel can expose. Modgud is its own OAuth 2.1 authorization server, so chat clients such as Claude and ChatGPT can connect. It maps every caller to a Grant, which sets the target service, the expiry, the tool allow and deny selectors, and the identity that Modgud passes to the tool.

Status: in build. `modgud serve` serves stdio MCP servers over Streamable HTTP to callers holding a static bearer token or OAuth tokens from Modgud's own OAuth server, approved with a Pairing code. Grants are not built yet: every credential belongs to one temporary harness that covers one Service.

## Running Modgud

`modgud serve` reads `~/.config/modgud/modgud.toml`, or the file that `--config` or `MODGUD_CONFIG` names. It serves each configured Service at `/<service>/mcp` on the Public listener, and the OAuth Approval page at `/authorize` on the Admin listener, until it receives SIGTERM or SIGINT. On shutdown it ends every Session, stops every Child, and stops both listeners.

```toml
[harness]
# The SHA-256 hash of the bearer token, in lowercase hex. Callers send the token
# itself as `Authorization: Bearer <token>`.
bearer_token_sha256 = "…"
# The one configured Service the token opens. At any other Service's path it
# gets HTTP 401.
service = "norn"
# Every OAuth authorization, and every token issued from it, expires this many
# days after approval.
max_token_lifetime_days = 30  # default; at most 365

[public]
# The HTTPS address callers reach through the tunnel. It is the OAuth issuer, and
# a Service's resource URI is <base_url>/<service>/mcp.
base_url = "https://modgud.example.com"
host = "127.0.0.1"    # default; loopback only: 127.0.0.1, ::1, or localhost
port = 8470           # default
max_sessions = 16     # default; an initialize past it gets HTTP 503
allowed_origins = []  # default; a request with any other Origin header gets HTTP 403

[admin]
# The HTTPS address of the Admin listener, served by a TLS-terminating proxy on
# the tailnet. The OAuth Approval page is <base_url>/authorize.
base_url = "https://modgud.example.ts.net"
host = "100.64.0.1"   # replace with this host's own tailnet address (in 100.64.0.0/10 or fd7a:115c:a1e0::/48)
port = 8471           # default

[store]
path = "~/.local/state/modgud/modgud.sqlite"  # default

[services.norn]
command = "norn"
args = ["mcp", "-C", "/path/to/vault"]
cwd = "/path/to/vault"        # optional
env = { NORN_ROOT = "/path/to/vault" }  # optional
idle_timeout_minutes = 30     # default; at most 10080 (one week)
# identity_env = "MIMIR_USER" # optional; reserved for the Grant's Identity
```

To make a token and its hash:

```sh
token=$(openssl rand -hex 32)
printf '%s' "$token" | sha256sum
```

To connect a chat client such as claude.ai or ChatGPT, add `<public.base_url>/<service>/mcp` as a connector. When the client opens the Approval page on the tailnet, check the host it names, run `modgud pair` on the host, and enter the code it prints. The Admin listener answers only requests for the host of `admin.base_url`, so the proxy in front of it must pass the `Host` header through. A code approves one connection and expires after 10 minutes (`--minutes` sets 1 to 60). `modgud revoke` revokes every connection approved so far. [docs/oauth.md](docs/oauth.md) specifies the OAuth server.

Each Session gets its own Child process. The Child's environment holds only `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `TMPDIR`, `TZ`, and `USER` from Modgud's own environment, plus the Service's `env`. A Session ends when the Caller deletes it, when it has no traffic in either direction for the Service's idle timeout, when its Child exits or writes a single line larger than 10 MiB, or when its Child does not answer `initialize` within 30 seconds. Modgud skips a shorter stdout line that is not JSON, and logs and skips one that is JSON but not JSON-RPC. A request still in flight does not keep a Session open.

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
