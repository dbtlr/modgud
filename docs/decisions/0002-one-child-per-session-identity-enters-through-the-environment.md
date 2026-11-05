---
type: adr
title: ADR-0002 - Each MCP session gets its own child process, and the Grant's Identity enters through its environment
description: "Modgud starts one child per MCP session on initialize, stops it on session DELETE or idle timeout, and sets the Grant's Identity in the Service's configured environment variable at spawn. A Service trusts that Identity because only Modgud starts it."
status: proposed
created: 2026-11-05
modified: 2026-11-05
---

# Each MCP session gets its own child process, and the Grant's Identity enters through its environment

## Context

Services are local stdio MCP tools, and a stdio server speaks to exactly one client. Modgud serves many Callers over Streamable HTTP, and some Grants carry an Identity that the Service must know, such as the Mimir user `drew`. Two things need settling: how Modgud maps sessions to processes, and how an Identity reaches a Service in a way the Service can trust. Services such as Mimir build against the answer.

## Decision

- **One child per MCP session.** Modgud spawns the Service's command on `initialize`. It stops the child on session DELETE or when the Service's idle timeout expires. Notifications and server-to-client requests pass through within the session.
- **Identity enters through the environment at spawn.** When the Grant carries an Identity, Modgud sets it in the environment variable the Service's configuration names. A Service without an Identity variable receives none.
- **This is the contract Services build against.**
  - A Service trusts the Identity in its environment because only Modgud starts it.
  - Modgud forwards no tool-level credential.
  - The Service decides what the Identity may do in its own domain; Modgud only asserts it.
  - Norn receives no Identity.
- **Tool definitions pass through unchanged.** Modgud removes filtered tools ([ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)) but never rewrites a schema or injects an argument, so the Identity never travels in tool arguments.

## Considered options

- One shared child per Service. Rejected: stdio servers are single-client, so sharing means rewriting request IDs, replaying `initialize` for each new session, and mixing Callers' Identities in one process.
- A child per call. Rejected: every call would pay the cold start. Measured on Asgard, `mimir mcp` takes about 400 ms and `norn mcp` about 45 ms. A per-session spawn pays once.

## Consequences

Each session's Identity is fixed for its child's life, and one process never serves two Identities.
A Service must be willing to take its Identity from its environment. Mimir needs to accept an asserted user from the environment and run without a clone binding.
If a chat client opens a session per conversation or turn, Mimir's roughly 400 ms startup lands each time. Mitigation: keep one warm idle child per Service and Identity so `initialize` answers immediately. Phase 1 measures how often each client opens a new session.
Limits that remain open: the maximum concurrent sessions, the idle timeout value, and where child stderr goes.
Passthrough coverage of `tools/list_changed`, progress, sampling, and elicitation is verified in Phase 1.
Groups and hints are trusted because the fleet's own tools declare them. A third-party tool behind Modgud would need groups from proxy configuration, which is out of scope for v1.
HTTP upstream Services, with the Identity in `_meta`, are a future extension and not part of this decision.

## Changelog

- 2026-11-05: Proposed. It becomes accepted as the Phase 1 code lands.
