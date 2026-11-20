---
type: adr
title: ADR-0005 - An HTTP Service is reached through one Link per Grant, behind the same Sessions as a Child
description: "A Service may be a loopback Streamable HTTP MCP server instead of a process. Modgud reaches it through one Link per Grant, which takes the Child's place under ADR-0002's Sessions and Messages rules: Modgud initializes it once at 2025-11-25, sends each Caller request as its own POST with a bearer read from a file, and stops it when idle or when the connection itself fails. An HTTP Service receives no Identity in v1."
status: proposed
created: 2026-11-20
modified: 2026-11-20
---

# An HTTP Service is reached through one Link per Grant, behind the same Sessions as a Child

## Context

[ADR-0002](0002-each-grant-shares-one-child-identity-enters-through-the-environment.md) settles Services that Modgud runs as processes and leaves HTTP Services as a future extension. Norn's next build serves MCP itself: `norn serve` binds a loopback address, answers MCP at `/mcp` over Streamable HTTP, and requires `Authorization: Bearer <secret>` with a secret from its token file, `<config_dir>/tokens.toml`, whose `[tokens.<label>]` tables each hold a `secret`. It re-reads that file on every request. It speaks 2025-11-25 through `initialize` and 2026-07-28 statelessly, issues no `Mcp-Session-Id`, answers GET and DELETE with 405, sends one `application/json` answer per POST, sends no server-initiated messages, and refuses any request that carries an `Origin` header. It needs no caller Identity. Norn's `/mcp` was not yet built when this decision was written, so these behaviors are Norn's stated contract, not observed ones.

Everything Modgud does for Callers lives in its Sessions: binding to a Grant, eviction, request limits, renumbering, stream bounds, and, from Phase 2, Selector enforcement. Callers such as claude.ai and ChatGPT still expect a 2025-era Session.

## Decision

### HTTP Services and Links

- **A Service is a process Service or an HTTP Service.** A process Service is configured with `command`, and Modgud runs it as a Child under ADR-0002. An HTTP Service is configured with `url` instead, and Modgud reaches it over Streamable HTTP. A Service names exactly one of the two, and a Service that names both, or neither, is a configuration error.
- **One Link per Grant, in the Child's place.** For an HTTP Service, each Grant has one Link: the `initialize` result and tool list Modgud holds for that Grant, and the Grant's requests in flight on the Service. A Link owns no process. One Link never serves two Grants. Every rule ADR-0002 states for a Grant's Child, under Sessions and Messages, applies to a Grant's Link unless this decision says otherwise. That covers Session binding, the Session and request limits, eviction, renumbering of request ids and progress tokens, the requests Modgud answers itself, generic errors, unresumable and bounded streams, and a Session outliving what serves it. So do [ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)'s Selectors and visible tool list.
- **Modgud is the Service's only client in the Link.** Modgud builds every request to the Service itself and forwards nothing from a Caller's HTTP request: no header, cookie, or query. It sends `Authorization: Bearer <secret>`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version` after `initialize`, and the Service's `Mcp-Session-Id` when it issued one. It sends no `Origin` header. It never follows a redirect: a 3xx answer is a bad answer to that request.

### Configuration

- **`url` is a loopback `http` URL.** It uses the `http` scheme, its host is `127.0.0.1`, `[::1]`, or `localhost`, it has a path, and it has no user information, query, or fragment, such as `http://127.0.0.1:28472/mcp`. Modgud refuses any other. Plain HTTP carries the bearer, so it never leaves the host, and the Service runs on Modgud's host as ADR-0001 requires. `localhost` reaches only the address it resolves to first, often `::1`, so configure the address the Service binds.
- **The bearer comes from a file.** `bearer_file` names the file. Without `bearer_key`, the secret is the file's contents with surrounding whitespace removed. With `bearer_key`, a dotted path such as `tokens.default.secret`, Modgud parses the file as TOML and takes the string at that path; each dot separates two keys, so the path cannot name a key that contains a dot. The secret must be non-empty and hold only visible ASCII characters. Norn's own token file therefore works unchanged, with `bearer_key = "tokens.<label>.secret"`, and so does any server whose secret sits alone in a file.
- **Modgud reads the bearer when a Link starts.** It does not read it at startup, so Modgud starts even when the Service has not yet created its token file. A missing or unreadable file, a file that is not valid TOML when `bearer_key` is set, a path that names no string, or an invalid secret makes that start fail, and Modgud logs a warning naming the Service, the file, and the reason. Modgud never logs the secret.
- **`idle_timeout_minutes` keeps its meaning,** with the same default and range as for a process Service. An HTTP Service takes none of `args`, `command`, `cwd`, `env`, or `identity_env`.

### The Link's life

- **A Link starts on demand.** Modgud starts a Grant's Link when a request must be forwarded and the Grant has no Link running, as ADR-0002 starts a Child. To start it, Modgud reads the bearer, POSTs one `initialize` request with protocol version `2025-11-25`, client information naming Modgud, and no client capabilities, then POSTs `notifications/initialized`. Once Selectors are enforced in Phase 2, it then fetches every page of `tools/list`, as ADR-0001 requires. All of this shares one 30-second deadline. A start fails when it misses the deadline, when the bearer cannot be read, when the Service answers `initialize` with an error or with a protocol version that is not a 2025-era version Modgud supports, when it does not answer `notifications/initialized` with 202, or when the tool list fetch fails. A failed start counts as a failure under ADR-0002's backoff. A start that succeeds keeps the result, which replaces the result an earlier Link gave, and ADR-0002's check of each Session against a changed result applies.
- **Modgud speaks 2025-11-25 to every HTTP Service.** It never probes 2026-07-28 and never sends `server/discover`. Whether Modgud speaks 2026-07-28 to a Service that supports it is settled with the design for 2026-07-28 Callers (ADR-0002, MCP revision 2026-07-28), for Children and Links alike.
- **A Service's `Mcp-Session-Id` binds the Link.** When the Service answers `initialize` with an `Mcp-Session-Id`, Modgud sends it on every later request of that Link and on no other Link. When a Link with a session id stops, Modgud sends the Service one DELETE with that id and ignores the answer.
- **Each Caller request is one POST.** Modgud sends each forwarded request in its own POST and reads the answer, whether the Service sends one `application/json` message or a `text/event-stream`. On a stream, the response and every progress notification reach their request as they would from a Child, and the stream ends once the response has arrived. A notification Modgud forwards goes in its own POST, and Modgud expects 202.
- **A message is at most 10 MiB,** the same bound as a Child's message. A larger one is a bad answer to that request.
- **Messages the Service sends outside a response follow ADR-0002.** `notifications/tools/list_changed` and the other list-change notifications go to every Session of the Grant, and a tool list change makes Modgud fetch the tool list again. A logging notification goes to Modgud's log. A request from the Service gets ADR-0002's answer, POSTed back to the Service. Modgud opens no GET stream on the Service, so it sees only the messages the Service sends on a POST's stream.
- **Cancelling a request aborts its POST.** For a Caller's `notifications/cancelled`, or a request of a Session that ends, Modgud POSTs the renumbered `notifications/cancelled` to the Service and aborts that request's POST, so it holds nothing more for it. A cancelled request still counts against the Grant's request limit until its POST has ended.
- **A Link stops when idle.** The idle clock starts once the Link has started. A Link stops once its Service's idle timeout passes with no message in either direction between Modgud and the Service. A request in flight does not hold it open, as for a Child.
- **A Link stops when its connection fails.** These failures show that the Link, not one request, is broken: the Service refuses or resets the TCP connection, answers any request with 401, or answers with 404 on a request that carries the Service's session id. Each stops the Link and counts as a failure under ADR-0002's backoff. Every request in flight on the Link gets a JSON-RPC error response, and the Grant's Sessions stay open, as when a Child exits. The next start reads the bearer again, so a rotated token takes effect after one 401.
- **Any other bad answer fails only its request.** A status other than 200 for a request or 202 for a notification, a redirect, a body that is neither one JSON-RPC message nor an event stream, a response whose id is not the request's, a stream that ends before its response, or a message over 10 MiB gives that request Modgud's generic error response and leaves the Link running. A bad answer to a notification is logged and dropped.
- **Stopping a Link is immediate.** Modgud aborts every POST in flight on the Link when it stops, so a new Link may start at once; nothing waits as a Child's exit does. A Grant's end and shutdown stop the Link as ADR-0002 stops a Child.

### Identity

- **An HTTP Service receives no Identity in v1.** The Service configuration has no Identity field for it, and in Phase 2 Modgud refuses to create or change a Grant that carries an Identity for an HTTP Service. How an Identity would reach an HTTP Service is settled once a Service needs one, because the receiving side is not yet designed.

## Considered options

- Pass a Caller's request through to the Service with its bearer swapped, and let 2026-07-28 Callers through untranslated. Rejected: Modgud would still need its own Sessions for 2025-era Callers and would still parse every message to filter tools, so it would grow a second, thinner Session model and apply Selectors in two places. Translating 2026-07-28 Callers belongs to the design ADR-0002 sets out for them, for both kinds of Service.
- One Link per Service, shared by its Grants. Rejected for v1: per-Grant request limits and a Grant's end would have to be tracked inside a shared object, and one Grant could affect another. A raw tool list can still be cached per Service later without changing this decision.
- Speak 2026-07-28 to a Service that supports it, or probe for it. Deferred to the design for 2026-07-28 Callers: it adds a second Service-side protocol path, and ADR-0002 speaks the 2025-era protocol to every Child.
- Read Norn's token file format only (`token_file` with `token_label`). Rejected: it builds one tool's file format into a proxy meant to front tools outside the fleet.
- A file that holds only the secret. Rejected as the only form: the operator would copy Norn's secret into a second file, which goes stale when the token rotates.
- Stop the Link on any bad answer, as a Child is stopped for unreadable output. Rejected: a Child's stream cannot be resynchronized after unreadable output, while one bad HTTP answer says nothing about the Service's other requests.
- Deliver the Grant's Identity in `_meta` on each request. Deferred: Norn needs none, and no Service has designed how it would receive one.

## Consequences

Norn's two checks hold by construction: Modgud sends no `Origin` header, and it opens with a 2025-11-25 `initialize`, which Norn serves. A Bun `fetch` sends no `Origin` header of its own, and the implementation pins that with a test.
Sessions, limits, renumbering, and Selector enforcement stay one code path for both kinds of Service.
An HTTP Service's tool list changes reach Modgud only through a list-change notification on a POST's stream, or when the Link starts again after idling out or failing. Norn declares no `listChanged`, so a Norn upgrade under steady use leaves the stored tool list stale until the Link restarts. That fails closed: a new tool counts as absent and is refused, and a removed tool's call gets the Service's own error.
Any local process that can read the bearer file can call the Service directly, bypassing Modgud's Selectors. The bearer is trusted only as far as the OS account that owns that file, as ADR-0002 trusts the Child's environment.
Each Grant pays its own `initialize`, and from Phase 2 its own tool list fetch, over loopback. While a Service is down, each Grant backs off on its own.
A tool call that runs longer than the Service's idle timeout without any message in either direction is cut off when the Link stops, as for a Child.
The behaviors in the Context are Norn's stated contract. Modgud is checked against the real `norn serve` once Norn's `/mcp` exists.

## Changelog

- 2026-11-20: Proposed. It becomes accepted as the code it governs lands.
