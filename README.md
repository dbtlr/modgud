# Modgud

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Modgud is an MCP auth proxy. It runs local stdio MCP servers, one child process per Grant shared by that Grant's MCP sessions, and serves them as Streamable HTTP MCP endpoints that a tunnel such as Cloudflare Tunnel can expose. Modgud is its own OAuth 2.1 authorization server, so chat clients such as Claude and ChatGPT can connect. It maps every caller to a Grant, which sets the target service, the expiry, the tool allow and deny selectors, and the identity that Modgud passes to the tool.

Status: in build. `modgud serve` serves stdio MCP servers over Streamable HTTP to callers holding a static bearer token or OAuth tokens from Modgud's own OAuth server, approved with a Pairing code. Grants are not built yet: every credential belongs to one temporary harness that covers one Service.

## Install the Linux prerelease

The initial release targets Linux x64 with glibc. Use the verified installer and retain the accompanying runtime notices and rebuild inputs.
See [installation and recovery](release/INSTALLING.md) and [runtime rebuild instructions](release/RELINKING.md).

`bun run build` produces the Linux x64 release binary, including when invoked on macOS.
For a host-native development binary, run `bun run --cwd packages/modgud loom build --release --out ../../dist/modgud`.

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
allowed_origins = []  # default; a request with any other Origin header gets HTTP 403
# The Sessions each Grant may hold, counting those still opening. At the limit, a
# new Session ends the Grant's least recently active one; an initialize gets
# HTTP 503 only when every Session of the Grant is still opening.
max_sessions_per_grant = 64          # default; replaces the retired max_sessions
session_idle_timeout_minutes = 1440  # default (one day); at most 10080 (one week)

[admin]
# The HTTPS address of the Admin listener, served by a TLS-terminating proxy on
# the tailnet. The OAuth Approval page is <base_url>/authorize.
base_url = "https://modgud.example.ts.net"
host = "100.64.0.1"   # this host's own tailnet address (in 100.64.0.0/10 or fd7a:115c:a1e0::/48),
                      # or 127.0.0.1 behind a tailnet forward such as `tailscale serve`, on a port other than public.port
port = 8471           # default

[store]
path = "~/.local/state/modgud/modgud.sqlite"  # default

[services.norn]
command = "norn"
args = ["mcp", "-C", "/path/to/vault"]
cwd = "/path/to/vault"        # optional
env = { NORN_ROOT = "/path/to/vault" }  # optional
idle_timeout_minutes = 30     # default; at most 10080 (one week); stops an idle Child
# identity_env = "MIMIR_USER" # optional; reserved for the Grant's Identity
```

To make a token and its hash:

```sh
token=$(openssl rand -hex 32)
printf '%s' "$token" | sha256sum
```

To connect a chat client such as claude.ai or ChatGPT, add `<public.base_url>/<service>/mcp` as a connector. When the client opens the Approval page on the tailnet, check the host it names, run `modgud pair` on the host, and enter the code it prints. The Admin listener answers only requests for the host of `admin.base_url`, so the proxy in front of it must pass the `Host` header through. A code approves one connection and expires after 10 minutes (`--minutes` sets 1 to 60). `modgud revoke` revokes every connection approved so far. [docs/oauth.md](docs/oauth.md) specifies the OAuth server.

Each Grant gets at most one Child process, started when a request needs it and shared by every Session the Grant opens. The static bearer token and each OAuth authorization count as separate Grants. Modgud initializes the Child itself and answers each Caller's `initialize` from the Child's result, without `tasks` or resource subscriptions in its capabilities. It renumbers request ids and progress tokens, so Sessions cannot collide on the Child, and answers `ping` and `logging/setLevel` itself. The Child's environment holds only `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `TMPDIR`, `TZ`, and `USER` from Modgud's own environment, plus the Service's `env`.

A Child stops when it has no traffic in either direction for the Service's idle timeout, when it exits, when it writes a single line larger than 10 MiB, or when it does not answer `initialize` within 30 seconds. Its Sessions stay open: the requests in flight on it get a JSON-RPC error, and the next request starts a new Child. A Child that fails to start, or exits on its own, is started again no sooner than 1 second later, doubling up to 60 seconds; a request that needs it before then fails at once. A Session ends when the Caller deletes it, after `public.session_idle_timeout_minutes` without activity, when a newer Session evicts it, when a restarted Child no longer offers what it was given, when its authorization is revoked or expires, or on shutdown. Each Grant holds at most 64 requests waiting for its Child or in flight. Modgud skips a stdout line shorter than 10 MiB that is not JSON, and logs and skips one that is JSON but not JSON-RPC. It logs the Child's stderr and its logging notifications, tagged with the Service and Grant, and keeps at most the first 2000 code points of a stderr line. For each stream a Caller has open, Modgud holds at most 1 MiB that the HTTP connection has not yet taken, plus one message; when a Caller stops reading and more output arrives, Modgud ends that stream and logs a warning, and the Session stays open. A Caller that stops reading keeps its connection until the socket buffers fill; once they are full, the connection ends after 60 seconds that take none of Modgud's output, with every stream on it. [ADR-0002](docs/decisions/0002-each-grant-shares-one-child-identity-enters-through-the-environment.md) specifies the full contract.

### Running as a service

`modgud service install` installs plain `modgud serve` as a user service and starts it: a systemd user unit, `com.dbtlr.modgud`, on Linux, or a launchd agent on macOS. The service runs from your home directory, so it reads the default configuration, and has no environment of its own. The service manager's `PATH` is minimal, so a Service whose `command` is not on it, such as one in `~/.local/bin`, needs an absolute `command` or a `PATH` in its `env`. `modgud service start`, `stop`, `restart`, `status`, and `uninstall` manage it. `status` exits 0 whenever it can report the service's state. `modgud service install` needs the compiled binary (`bun run build`), not a source checkout. The service commands come from Loom's service plugin.

Modgud logs through Loom's logging plugin: one JSON record per event in `~/.local/state/modgud/modgud.jsonl` on Linux (`$XDG_STATE_HOME/modgud/` when set), or `~/Library/Logs/modgud/modgud.jsonl` on macOS. The file rotates at 10 MB and keeps five copies. Warnings about the configuration or the store go to the log and to stderr, and a failure to write the log is printed to stderr once. `modgud serve` also prints the addresses it listens on, and that it stopped, to stdout.

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
