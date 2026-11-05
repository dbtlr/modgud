---
type: adr
title: ADR-0001 - Callers reach a Service through a Grant, and Modgud is its own OAuth 2.1 authorization server
description: "Every Caller resolves to a Grant, and every credential derives from one: a static bearer token for agents, or OAuth tokens that Modgud itself issues to chat clients after a Pairing code binds them on a tailnet-only approval page."
status: proposed
created: 2026-11-05
modified: 2026-11-05
---

# Callers reach a Service through a Grant, and Modgud is its own OAuth 2.1 authorization server

## Context

Modgud serves local stdio MCP tools (Services) to remote Callers. The Callers that matter most are chat clients, and they authenticate remote MCP servers with OAuth, not with pasted tokens:

- Claude custom connectors use OAuth with Dynamic Client Registration (DCR) or Client ID Metadata Documents (CIMD). Static request headers are beta, and one Anthropic page still says pasted bearer tokens are unsupported ([authentication](https://claude.com/docs/connectors/building/authentication), [custom connectors](https://claude.com/docs/connectors/custom)).
- ChatGPT developer mode lists OAuth, no authentication, or both. An API-key field appears only in some releases ([developer mode](https://developers.openai.com/api/docs/guides/developer-mode)).
- Muninn's `/mcp` takes static `art_` keys. Those serve Claude Code and Codex but not chat clients.

A static token declaring its Service, expiry, and deny list would serve agents and fail the chat clients. Modgud therefore needs a credential-independent record of who may reach what.

A survey on 2026-11-04 found no product that combines all four needs: its own OAuth server that claude.ai and ChatGPT accept, Grants, Identity passthrough, and a tool deny list. `mcp-stdio serve` ([source](https://github.com/shigechika/mcp-stdio)) has the closest OAuth server, with protected-resource metadata, DCR, CIMD, PKCE, and a static-token mode, but it serves one backend per instance and has no Grants, no deny list, and no admin CLI. ContextForge and Bifrost cover access control and filtering, but neither was confirmed to act as an OAuth server that claude.ai can register with. Cloudflare MCP Portals and Pomerium cannot run stdio tools. supergateway and sparfenyuk/mcp-proxy only bridge transports.

## Decision

- **A Grant is the managed object.** It is an admin-managed record for one Caller and exactly one Service: a label, `expires_at`, allow and deny Selectors, an optional Identity, `revoked_at`, and the OAuth client name and redirect host recorded at pairing. The Grant's expiry caps every credential derived from it, and revoking the Grant ends them all.
- **Credentials derive from the Grant.** A static bearer token is a random secret shown once and stored only as a hash. OAuth tokens are issued by Modgud to a chat client bound to the Grant.
- **Modgud is its own OAuth 2.1 authorization server.** It serves protected-resource and authorization-server metadata, DCR and CIMD client registration, a token endpoint, PKCE S256, and rotating refresh tokens. Access tokens are short-lived and audience-bound to the `resource` the client sends. Modgud borrows `mcp-stdio`'s OAuth design as a reference and does not fork it.
- **A Pairing code binds a chat client to a Grant.** An admin mints a single-use code from the Grant, with a lifetime of minutes. The person enters it on the OAuth approval page, which is the `authorization_endpoint`. The page lives on the tailnet-only admin listener ([ADR-0003](0003-two-listeners-anything-a-person-clicks-lives-on-the-tailnet.md)), so approving a connection requires being on the tailnet. One code redeems one client registration; re-pairing takes a new code.
- **Selectors filter tools, and deny wins.** `tool:<name>`, `hint:readOnly`, `hint:destructive`, `hint:idempotent`, `hint:openWorld`, and `group:<name>` match tools. With no allow list every tool passes; with one, only matches pass; the deny list then removes matches. Modgud enforces this at `tools/list` and refuses at `tools/call`, because a client can call a hidden tool by name. Modgud never rewrites a tool definition or injects arguments.
- **Grants live in SQLite.** Services live in the config file in v1.

## Considered options

- Static bearer tokens alone, each declaring its Service, expiry, and deny list. Rejected: chat clients cannot use them.
- Adopt `mcp-stdio` or another surveyed product. Rejected: none combines an OAuth server that chat clients accept, Grants, Identity passthrough, and tool filtering. `mcp-stdio` is also Python and limited to one backend.
- Put an identity provider in front, as Cloudflare MCP Portals and Pomerium do. Rejected: they cannot run stdio tools.
- Build authentication into each tool, one ADR at a time, as Muninn did. Rejected: every CLI-based MCP tool would need its own OAuth server to reach chat clients.

## Consequences

Every CLI-based MCP tool becomes reachable from every chat client without owning caller authentication.
Modgud is security-sensitive code: an OAuth server, credential storage, and a public endpoint. A bug exposes tools to the internet.
Its value depends on chat clients keeping their current OAuth behavior, and Modgud must track MCP authorization spec revisions and client quirks. The Phase 1 end-to-end connection from claude.ai and ChatGPT is kept as a repeatable check.
Static bearer tokens for agents are independently justified even if chat-client OAuth never works.
Sharp edges to confirm in Phase 1: claude.ai uses only the first `authorization_servers` entry and needs a 401 with `WWW-Authenticate` to start sign-in; the token endpoint must accept form-urlencoded bodies; discovery, registration, and token calls have a 10-second limit; ChatGPT's redirect URI is `https://chatgpt.com/connector_platform_oauth_redirect` or a per-connector callback URL; the `Origin` header behavior of chat clients is unverified.
Open items: access tokens last about an hour with Grant expiry capping both token kinds; authentication of the admin API and panel on the tailnet (a Tailscale `whois` allowlist for the panel, an admin token for the CLI) is settled in Phase 2; whether ChatGPT opens the tailnet-only approval page in the browser is unconfirmed; Claude Duet, ChatGPT Dot, Grokbot, and Meta Muse were named as targets but their auth support is unverified.

## Changelog

- 2026-11-05: Proposed. It becomes accepted as the Phase 1 code lands.
