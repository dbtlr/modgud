---
type: adr
title: ADR-0002 - Each MCP session gets its own child process, and the Grant's Identity enters through its environment
description: "Modgud starts one Child per Session on initialize and binds the Session to the Grant that opened it. The Child's environment comes only from the Service's configuration and a fixed base allowlist, and only the Grant sets the Identity variable, which is trusted only as far as the OS account that runs Modgud and the Service."
status: proposed
created: 2026-11-05
modified: 2026-11-05
---

# Each MCP session gets its own child process, and the Grant's Identity enters through its environment

## Context

Services are local stdio MCP tools, and a stdio server speaks to exactly one client. Modgud serves many Callers over Streamable HTTP, and some Grants carry an Identity that the Service must know, such as the Mimir user `drew`. Two things need settling: how Modgud maps Sessions to processes, and how an Identity reaches a Service and how far the Service can trust it. Services such as Mimir build against the answer.

## Decision

- **One Child per Session.** Modgud spawns the Service's command on `initialize`. It stops the Child on session DELETE or when the Service's idle timeout expires. Notifications and server-to-client requests pass through within the Session.
- **A Session is bound to the Grant that opened it.** Every request on a Session (POST, GET, DELETE, or a reconnect) carries a credential that is currently valid and derives from the same Grant that opened the Session. A request with no valid credential gets the 401 that [ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md) requires. A request whose credential derives from another Grant gets the same HTTP 404 as an unknown session id, so it learns nothing about the Session. Modgud never routes either request to the Child.
- **A Grant's end ends its Sessions.** Revoking or expiring a Grant ends its Sessions and stops their Children at once, not at idle timeout.
- **A Child that exits ends its Session.** When a Child exits on its own, its Session ends. Later requests on that session id get the MCP "session not found" response, HTTP 404.
- **A Child's environment comes only from configuration.** Modgud builds it from the Service's configured environment plus a fixed allowlist of base variables copied from Modgud's environment, such as `PATH` and `HOME`; the exact list is set in Phase 1. Nothing else from Modgud's environment reaches the Child.
- **Only the Grant sets the Identity variable.** The environment variable that the Service's configuration names for Identity is reserved. Modgud removes any value for it from the configured environment and the base, then sets it only from the Grant. When the Grant has no Identity, the variable is absent. A Service without an Identity variable receives none.
- **This is the contract Services build against.**
  - Trust comes from the channel: Modgud starts the Child and sets the Identity in its environment.
  - Modgud forwards no tool-level credential.
  - Any process under the same OS account can start the Service with any Identity in its environment. An Identity asserted through the environment is therefore trusted only as far as the OS account that runs Modgud and the Service. It adds no protection against local processes under that account, and a Service must not treat it as stronger.
  - The Service decides what the Identity may do in its own domain; Modgud only asserts it.
  - Norn receives no Identity.
- **Tool definitions pass through unchanged.** Modgud removes filtered tools ([ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)) but never rewrites a schema or injects an argument, so the Identity never travels in tool arguments.

## Considered options

- One shared Child per Service. Rejected: stdio servers are single-client, so sharing means rewriting request IDs, replaying `initialize` for each new Session, and mixing Callers' Identities in one process.
- A Child per call. Rejected: every call would pay the cold start. Measured on the host that runs Modgud, `mimir mcp` takes about 400 ms and `norn mcp` about 45 ms. A per-Session spawn pays once.

## Consequences

Each Session's Identity is fixed for its Child's life, and one process never serves two Identities.
A credential stolen from one Grant cannot ride on another Grant's Session, and a revoked Grant leaves no Child running.
A Service must be willing to take its Identity from its environment. Mimir needs to accept an asserted user from the environment and run without a clone binding.
If a chat client opens a Session per conversation or turn, Mimir's roughly 400 ms startup lands each time. Candidate mitigation: keep one warm idle Child per Service and Identity so `initialize` answers immediately. A warm Child starts before its Session exists, so adopting this mitigation would amend this ADR and the glossary's definition of Child. Phase 1 measures how often each client opens a new Session.
Limits that remain open: the maximum concurrent Sessions, the idle timeout value, and where Child stderr goes.
Passthrough coverage of `tools/list_changed`, progress, sampling, and elicitation is verified in Phase 1.
Groups and hints are trusted because the fleet's own tools declare them. A third-party tool behind Modgud would need Groups from proxy configuration, which is out of scope for v1.
HTTP upstream Services, with the Identity in `_meta`, are a future extension and not part of this decision.

## Changelog

- 2026-11-05: Proposed. It becomes accepted as the Phase 1 code lands.
- 2026-11-05: Revised while proposed. Each Session is bound to its Grant and ends with the Grant or the Child, the Child's environment comes only from configuration, and the trust statement names the OS account as its boundary.
