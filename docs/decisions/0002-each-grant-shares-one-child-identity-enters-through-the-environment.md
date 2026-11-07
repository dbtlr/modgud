---
type: adr
title: ADR-0002 - Each Grant shares one on-demand child process across its MCP Sessions, and the Grant's Identity enters through its environment
description: "Modgud runs at most one Child per Grant, started on demand and shared by every Session the Grant opens, and binds each Session to that Grant. A Session outlives its Child. The Child's environment comes only from the Service's configuration and a fixed base allowlist, and only the Grant sets the Identity variable, which is trusted only as far as the OS account that runs Modgud and the Service."
status: proposed
created: 2026-11-05
modified: 2026-11-07
---

# Each Grant shares one on-demand child process across its MCP Sessions, and the Grant's Identity enters through its environment

## Context

Services are local stdio MCP tools, and a stdio server speaks to exactly one client. Modgud serves many Callers over Streamable HTTP, and some Grants carry an Identity that the Service must know, such as the Mimir user `drew`. Three things need settling: how Modgud maps Sessions to processes, how an Identity reaches a Service, and how far the Service can trust it. Services such as Mimir build against the answer.

The first version of this decision gave each Session its own Child. The end-to-end proof showed that chat clients never end their Sessions and open them in bursts: ChatGPT opened five within about a minute ([observed client behavior](../oauth.md#observed-client-behavior)). With one Child per Session held until the idle timeout, ordinary use would exhaust the Session limit within minutes. MCP revision 2026-07-28 also removes sessions from the protocol, so a Child bound to a Session has no future there.

## Decision

### Children

- **One Child per Grant, shared by its Sessions.** Modgud runs at most one Child for each Grant. Every Session the Grant opens uses it. One Child never serves two Grants, so one process never serves two Identities.
- **A Child starts on demand.** Modgud starts the Grant's Child when a request needs it and none is running: a Caller's `initialize`, or any request on a Session whose Child has stopped. Requests that arrive while it starts wait for it.
- **Modgud initializes the Child itself.** Modgud sends the Child one `initialize` request with protocol version `2025-11-25`, client information naming Modgud, and no client capabilities. When the Child answers, Modgud sends `notifications/initialized` and keeps the Child's initialize result. A Child that has not answered within 30 seconds is stopped. A Child that answers with an error or a result without a protocol version is stopped too.
- **A Child stops when idle.** A Child stops once its Service's idle timeout passes with no message in either direction between Modgud and the Child. A request in flight does not hold it open, because a Child sends no response to a request that was cancelled.
- **A Session outlives its Child.** When a Child stops, whether idle, exited, or stopped for unreadable output, the Grant's Sessions stay open. Every request still in flight on the Child gets a JSON-RPC error response. The next request starts a new Child. A Child that cannot be started or initialized fails only the requests waiting for it: an `initialize` gets HTTP 502, and a request on an open Session gets a JSON-RPC error response.
- **A Grant's end ends its Sessions and its Child.** Revoking or expiring a Grant ends its Sessions and stops its Child at once, not at idle timeout.

### Sessions

- **A Session is bound to the Grant that opened it.** Every request on a Session (POST, GET, DELETE, or a reconnect) carries a credential that is currently valid and derives from the same Grant that opened the Session. A request with no valid credential gets the 401 that [ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md) requires. A credential for another Service is not valid here and gets that 401 too. A valid credential for this Service that derives from another Grant gets the same HTTP 404 as an unknown session id, so it learns nothing about the Session. Modgud never routes either request to a Child.
- **Modgud answers `initialize` from the Child's result.** A Caller's `initialize` gets the Child's server information, capabilities, and instructions. Its protocol version is the one the Caller requested when Modgud supports it and it is no newer than the Child's; otherwise it is the Child's. Modgud consumes the Caller's `notifications/initialized` and does not forward it.
- **A Session ends on delete, idle, eviction, its Grant's end, or shutdown.** A Session ends when the Caller deletes it, when `public.session_idle_timeout_minutes` (1440, one day, by default) passes with no activity on it, when it is evicted, when its Grant ends, or when Modgud shuts down. A Child stopping does not end it. Later requests on an ended Session's id get the MCP "session not found" response, HTTP 404.
- **A Grant holds a bounded number of Sessions.** Each Grant holds at most `public.max_sessions_per_grant` Sessions, 64 by default, counting those still opening. An `initialize` past that limit evicts the Grant's least recently active Session and then opens the new one, so a new Session is never refused for the limit. A Session's activity is any HTTP request on it or any message to or from it.
- **An ended Session cancels its work.** When a Session ends while its Child keeps running, Modgud sends the Child `notifications/cancelled` for each of the Session's requests still in flight.

### Messages

- **Modgud renumbers what identifies a request.** Modgud gives each Caller request it forwards a request id that is unique within the Child, and each progress token it carries a token that is unique within the Child. It maps them back on the way out. It rewrites the `requestId` of a Caller's `notifications/cancelled` the same way. Everything else in a forwarded message passes through unchanged.
- **Messages from the Child reach their owner.** A response goes to the Session and request whose id it carries. A progress notification goes to the request whose token it names. `notifications/tools/list_changed`, `notifications/prompts/list_changed`, `notifications/resources/list_changed`, and `notifications/resources/updated` go to every Session of the Grant, on its GET stream when one is open. Any other message that belongs to no single request, such as a logging notification, goes to Modgud's log and is not forwarded.
- **Modgud answers a Child's requests itself.** Modgud answers a Child's `ping` with an empty result, and any other request from a Child, such as sampling, elicitation, or `roots/list`, with JSON-RPC error -32601, method not found. The Child sees no client capabilities, so a conforming Service sends none of these.
- **Modgud drops Caller messages that have no Child counterpart.** Caller notifications other than `notifications/cancelled` and Caller responses go nowhere, because the Child sent the Caller no requests.
- **Tool definitions pass through unchanged.** Modgud removes filtered tools ([ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)) but never rewrites a schema or injects an argument, so the Identity never travels in tool arguments.

### Environment and Identity

- **A Child's environment comes from configuration and a fixed base.** Modgud builds it from the Service's configured environment plus a fixed allowlist of base variables copied from Modgud's environment: `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `TMPDIR`, `TZ`, and `USER`. A configured value overrides a base value. Nothing else from Modgud's environment reaches the Child.
- **Only the Grant sets the Identity variable.** The environment variable that the Service's configuration names for Identity is reserved. Modgud removes any value for it from the configured environment and the base, then sets it only from the Grant. When the Grant has no Identity, the variable is absent. A Service without an Identity variable receives none.
- **This is the contract Services build against.**
  - Trust comes from the channel: Modgud starts the Child and sets the Identity in its environment.
  - Modgud forwards no tool-level credential.
  - Any process under the same OS account can start the Service with any Identity in its environment. An Identity asserted through the environment is therefore trusted only as far as the OS account that runs Modgud and the Service. It adds no protection against local processes under that account, and a Service must not treat it as stronger.
  - The Service decides what the Identity may do in its own domain; Modgud only asserts it.
  - A Service serves every Session of one Grant from one process, may be stopped when idle and started again at any time, and must not rely on state that only one client's `initialize` sets up.
  - Norn receives no Identity.
- **Each non-blank line a Child writes to stderr goes to Modgud's log,** tagged with its Service and Grant.

### MCP revision 2026-07-28

Modgud serves the 2025-era Streamable HTTP transport. It answers a 2026-07-28 probe as a 2025-era server does, so Callers that negotiate fall back to `initialize`. When Modgud serves 2026-07-28 Callers, it translates their stateless requests onto the same Child of the same Grant: it answers `server/discover` from the Child's initialize result and renumbers ids as above. Modgud speaks the 2025-era protocol to every Child, whichever era its Callers speak.

## Considered options

- One Child per Session, as this decision first said. Rejected: chat clients never end Sessions, so Children pile up until the idle timeout, and the Session limit binds within minutes of ordinary use. Evicting the oldest Session at the limit would keep that model working, but every new conversation would still pay the Child's startup.
- One shared Child per Service. Rejected: it mixes Callers' Identities in one process, and revoking one Grant could not stop its Child.
- A Child per call. Rejected: every call would pay the cold start. Measured on the host that runs Modgud, `mimir mcp` takes about 400 ms and `norn mcp` about 45 ms.
- A Child always running for every Grant. Rejected: it holds a process per Grant even when nobody uses it, while a stopped Child costs only one startup on the next request.
- Speaking 2026-07-28 to a Child that supports it. Deferred: Mimir speaks only the 2025-era protocol, and one code path serves every current Service.

## Consequences

Each Child's Identity is fixed for its life, and one process never serves two Identities or two Grants.
A credential stolen from one Grant cannot ride on another Grant's Session, and a revoked Grant leaves no Child running.
A Grant's Sessions share whatever state the Service keeps in its process, and lose it when the Child stops. Resource subscriptions are shared across the Grant's Sessions, so one Session's unsubscribe ends the subscription for all of them, and a restarted Child holds none.
A Child's requests to the Caller, sampling, elicitation, and roots, are not supported. Neither Mimir nor Norn sends them, and MCP revision 2026-07-28 drops server-to-client requests.
Logging notifications and task status notifications from a Child go to Modgud's log, not to a Caller.
A Session's first request after its Child idled out pays the Child's startup, about 400 ms for Mimir.
A Service must be willing to take its Identity from its environment. Mimir needs to accept an asserted user from the environment and run without a clone binding.
A tool call that runs longer than its Service's idle timeout without any message in either direction is cut off when the Child stops.
A Service that fails on every start is started again for every request that needs it.
Groups and hints are trusted because the fleet's own tools declare them. A third-party tool behind Modgud would need Groups from proxy configuration, which is out of scope for v1.
HTTP upstream Services, with the Identity in `_meta`, are a future extension and not part of this decision.

## Changelog

- 2026-11-05: Proposed. It becomes accepted as the code it governs lands.
- 2026-11-05: Addendum. Settled the base environment allowlist, the Session limits, and how messages from a Child reach the Caller request they belong to, as the Phase 1 code landed. Recorded that the decision assumes the 2025-era session handshake. It stays proposed until the Child model for MCP revision 2026-07-28 is settled.
- 2026-11-06: Addendum. A revocation made by another process, such as `modgud revoke`, reaches the server through the store, so "at once" means within 10 seconds for those Sessions.
- 2026-11-07: Addendum. The end-to-end proof measured Session churn ([observed client behavior](../oauth.md#observed-client-behavior)). Neither claude.ai nor ChatGPT ended a Session during the five minutes observed, and ChatGPT opened five within about a minute.
- 2026-11-07: Revised. One Child per Session became one on-demand Child per Grant, shared by the Grant's Sessions, with Sessions that outlive their Child. The global limit of 16 Sessions with HTTP 503 became a per-Grant limit of 64 that evicts the least recently active Session, and a Session now idles out after one day instead of with its Child. Modgud initializes the Child itself, renumbers request ids and progress tokens, and answers a Child's requests to the Caller itself. MCP revision 2026-07-28 Callers will be translated onto the same Child. Renamed from "Each MCP session gets its own child process".
