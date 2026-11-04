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
A label a Service declares on its own tools, such as `admin`, so Grants can select those tools together.
_Avoid_: Category, tag

**Identity**:
The opaque value a Grant passes to its Service to say who the Caller acts for, such as the Mimir user `drew`. Modgud asserts it; the Service decides what it permits.
_Avoid_: User token, credential

**Pairing code**:
A single-use, short-lived code minted from a Grant and entered on the approval page to bind a chat client's OAuth registration to that Grant.
_Avoid_: Invite, one-time password
