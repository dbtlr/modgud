---
type: adr
title: ADR-0006 - Each Grant sends a bounded number of tool calls per minute, and a refused call gets a tool error the model can read
description: "Modgud rate-limits the tools/call requests it sends to a Service, per Grant, for every Service: at most a Service's max_tool_calls_per_minute (120 by default) in any 60 seconds. A call past the limit is not sent; it gets a tool result with isError true whose fixed text says how many seconds to wait. In Phase 2 a Grant may override its Service's limit."
status: proposed
created: 2026-11-20
modified: 2026-11-20
---

# Each Grant sends a bounded number of tool calls per minute, and a refused call gets a tool error the model can read

## Context

Both MCP revisions Modgud tracks, 2025-11-25 and 2026-07-28, list "Rate limit tool invocations" among what servers MUST do (server/tools, Security Considerations). Neither says how a server refuses a call. Norn's `/mcp` declares that requirement unmet on its own side: it is a single-user loopback server behind a bearer, and remote Callers reach it only through Modgud. The deployed path meets the requirement only if Modgud limits tool calls, for every Service, whatever each tool does itself.

[ADR-0002](0002-each-grant-shares-one-child-identity-enters-through-the-environment.md) already bounds each Grant to 64 requests open at once. That bounds how much a Grant holds at one time, not how many calls it makes over time: a Caller whose calls finish quickly can make them without end.

The spec defines two ways to fail a tool call, and tells clients how to treat each. A tool result with `isError: true` is a tool execution error, and clients SHOULD give it to the language model "to enable self-correction". A JSON-RPC error is a protocol error, which clients MAY give to the model, though it is "less likely to result in successful recovery". The transport says nothing about HTTP 429.

## Decision

- **Modgud limits the `tools/call` requests it sends to a Service, per Grant.** A Grant sends at most its limit of `tools/call` requests to its Service in any 60 seconds, counted over a sliding window. This applies to every Service, process or HTTP, and to every Child and Link of the Grant, so a Service restart, idle stop, or new Link does not reset the count.
- **A call counts when Modgud hands it to the Child or Link.** Just before it hands a Caller's `tools/call` to the Grant's Child or Link to send, Modgud checks the Grant's window. A call that fits is handed over and counts, whether or not it then reaches the Service: a Link's POST that fails, or a Child that exits before reading it, does not give the count back. A call that does not fit is not sent and does not count. A call Modgud answers itself never counts: one refused by this limit, one refused for ADR-0002's request limit, one for a tool the Grant's Selectors hide or the Service does not have ([ADR-0001](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)), and one that fails before it is sent because its Session or Grant ended or its Child or Link could not start. A sent call that is later cancelled still counts. No other method counts.
- **A refused call gets a tool error.** Modgud answers it with a `CallToolResult` whose `isError` is `true`, whose `content` is one text block, and whose `_meta` holds `com.dbtlr.modgud/retryAfterSeconds`, the number of whole seconds until one more call fits the window, rounded up and at least 1. The text is fixed apart from its two numbers: `Rate limit reached: the limit is <limit> tool calls per minute. Try again in <seconds> seconds.`, with `tool call` in place of `tool calls` when the limit is 1, and `second` in place of `seconds` when the wait is 1. This is the one error Modgud answers in a Child's place whose text is not wholly fixed, as an exception to ADR-0002's rule that Modgud's own errors are generic; the numbers say nothing about the Service. The result carries no `structuredContent`. The refusal goes to the Caller on the request's stream like any other response. When Modgud serves 2026-07-28 Callers, their translation carries the refusal as it carries any tool result, and a Caller's retry is a new `tools/call` that counts again.
- **The limit is `max_tool_calls_per_minute`, set per Service.** It is an integer from 1 to 6000, 120 by default, and applies to both process and HTTP Services. A value outside that range is a configuration error, and Modgud does not start. There is no setting that turns the limit off.
- **In Phase 1, each harness credential is its own Grant.** The static token and each harness Authorization each count against their own window, at their Service's limit, as ADR-0001 already treats them for Session binding.
- **In Phase 2, a Grant may override its Service's limit.** A Grant record carries an optional `max_tool_calls_per_minute` with the same range. When it is absent, the Service's setting applies. The Grant's window is checked against its current limit, so a change to the Grant record takes effect as soon as Modgud applies other changes to that Grant record, and calls already counted stay counted. The Service's setting lives in the configuration file, which Modgud reads at start, so a change to it takes effect when Modgud restarts.
- **Modgud logs a limited episode, not each refusal.** An episode starts when this limit refuses a Grant's call while the Grant is not in an episode, and Modgud then logs a warning naming the Grant and the limit. The episode ends at the first call handed to the Child or Link after a full 60 seconds in which this limit refused none of the Grant's calls, or when the Grant ends or Modgud shuts down. When it ends, Modgud logs at info level how many of the Grant's calls this limit refused during the episode, the first included. Calls answered for any other reason neither start nor end an episode. Each episode costs two log lines, and a Grant's next episode starts at least 60 seconds after the last one started, however the Caller times its calls.
- **The count lives in memory with the Grant.** Modgud keeps each Grant's window and episode in memory with the rest of what it holds for the Grant, from the Grant's first request until the Grant ends or Modgud shuts down. A window holds only the timestamps of counted calls, never more than the highest limit, 6000, and drops those older than 60 seconds when it is next checked. A restart of Modgud starts every window empty.
- **Registration and Pairing limits are unchanged.** This decision covers tool calls by Callers that hold a valid credential. ADR-0001's open item on abuse limits for client registration, Pairing code entry, and metadata fetches stays as it is.

## Considered options

- Answer a refused call with HTTP 429 and `Retry-After`. Rejected: the refusal arrives before any MCP message, so a client's MCP layer reports a transport failure, the model sees at most a generic error, and some clients may take the whole connector for broken.
- Answer it with a JSON-RPC error, like ADR-0002's request limit. Rejected: clients only MAY show a protocol error to the model, so whether a Caller can recover would depend on the client. ADR-0002's request limit keeps its JSON-RPC error, because it is a different condition that clears as the Grant's open requests finish.
- Count every request Modgud forwards. Rejected: only `tools/call` can be refused with a tool error, so other methods would need a second refusal shape, and the burst of list requests a chat client sends when it opens Sessions would spend the limit before any tool runs. Other methods stay bounded only in how many are open at once, by ADR-0002's request limit.
- A token bucket with a burst size and a refill rate. Rejected: it is a second rate-limiting mechanism beside the sliding window Modgud already uses for registration, Pairing codes, and metadata fetches, and a second setting, for a limit meant as a safety bound rather than a quota.
- Two windows, one for bursts and one for sustained use. Rejected for v1: two settings and a refusal that reports the longer wait, for no need yet seen.
- Limits per tool as well as per Grant. Deferred: no Service has a tool that needs its own limit yet. The count is internal, so a per-tool limit can be added later as a new setting and a finer key without changing this decision.
- A global setting instead of a per-Service one. Rejected: what a call costs depends on the Service, from a Norn query that takes milliseconds to a Mimir call.
- Log every refusal, as ADR-0002's request limit does today. Rejected: a Caller that loops on the limit could fill the log.
- Log one warning at the first refusal and the count at the next call sent. Rejected: a Caller whose counted calls are spread across the window, and that calls without pause, is refused and then sent a call each time a timestamp leaves the window, which would log two lines per call sent.

## Consequences

The deployed path meets the MCP requirement to rate-limit tool calls for every Service behind Modgud, and Norn need not limit its own `/mcp`.
A model that reads the refusal can wait, tell the person, or move on, if its client shows tool errors to the model as the spec asks. How claude.ai and ChatGPT present the refusal is checked on the deployed path, and this decision stays proposed until that check reports.
A Caller can spend its whole minute at once and then waits for its oldest call to leave the window.
A Caller that cancels a call it sent cannot win it back, and a burst of calls that waited for a Child or Link to start can be partly refused when they are all sent at once.
A refused call to a tool that declares an `outputSchema` carries no `structuredContent`. The spec says servers MUST provide structured results that conform to the schema. The MCP TypeScript SDK's client checks that only for results whose `isError` is not `true`; a client that also validates error results against the schema would report a validation error instead of the refusal.
A restart of Modgud resets every Grant's count, so a Caller can make up to twice its limit across a restart within one minute.
The limit bounds tool calls per Grant, not across Grants: a Service behind many busy Grants can still receive many calls, each Grant within its own limit.

## Changelog

- 2026-11-20: Proposed. It becomes accepted once the limit is implemented and the refusal is checked against claude.ai and ChatGPT on the deployed path.
