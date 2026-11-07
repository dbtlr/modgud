# Modgud Glossary

Modgud is an MCP auth proxy that lets remote callers reach local MCP tools. These terms name what it guards and who it lets through.

## Language

**Service**:
A local MCP tool that Modgud serves at its own path, such as Norn at `/norn/mcp`.
_Avoid_: Backend, upstream, server (when meaning the tool)

**Caller**:
The client that reaches a Service through Modgud, such as Claude chat, ChatGPT, or a fleet agent.
_Avoid_: User (a Caller is a client, not a person)

**Grant**:
The admin-managed permission for one Caller to reach one Service until an expiry. It carries the Caller's label, its Selectors, and an optional Identity. Every credential a Caller holds derives from a Grant and dies with it.
_Avoid_: Token, API key (those are credentials derived from a Grant)

**Selector**:
An entry in a Grant's allow or deny list that matches tools by name, by standard tool hint, or by Group.
_Avoid_: Rule, filter (a filter is the result of all Selectors)

**Group**:
A label a Service declares in its own tool definitions, such as `admin`, so Grants can select those tools together.
_Avoid_: Category, tag

**Identity**:
The opaque value a Grant passes to its Service to say who the Caller acts for, such as the Mimir user `drew`. Modgud asserts it; the Service decides what it permits.
_Avoid_: User token, credential

**Pairing code**:
A single-use, short-lived code minted from a Grant and entered on the Approval page to approve one chat-client Authorization for that Grant. In Phase 1, `modgud pair` mints it for the temporary credential harness.
_Avoid_: Invite, one-time password

**Approval page**:
The page at Modgud's OAuth authorization endpoint where a person sees a chat client's name and the redirect URI its authorization code will be sent to, then enters a Pairing code to approve that client's authorization. It is served only on the Admin listener.
_Avoid_: Login page, consent screen

**Public listener**:
The listener that binds localhost, is reached only through the tunnel, and serves only the Service endpoints and the OAuth endpoints that chat-client servers call.
_Avoid_: Frontend, gateway

**Admin listener**:
The listener that binds a tailnet address, or loopback behind a tailnet forward, and serves the Approval page, the admin API, and the admin panel.
_Avoid_: Private port, backend

**Authorization**:
One approved chat-client connection: a client, the redirect URI it was approved for, and the Service it reaches, from approval until it expires or is revoked. Its access and refresh tokens derive from it, and the Sessions it opens are bound to it.
_Avoid_: Consent, login

**Session**:
One MCP session between a Caller and a Service under one Grant, from `initialize` until the Caller deletes it, it idles out, it is evicted, a new Child no longer matches what it was given, its Grant is revoked or expires, or Modgud shuts down. It outlives the Child that serves it.
_Avoid_: Connection, conversation

**Child**:
The Service process Modgud runs for one Grant, started on demand and shared by every Session of that Grant, with the Grant's Identity in its environment.
_Avoid_: Worker, instance
