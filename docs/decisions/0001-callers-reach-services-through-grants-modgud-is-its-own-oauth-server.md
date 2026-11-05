---
type: adr
title: ADR-0001 - Callers reach a Service through a Grant, and Modgud is its own OAuth 2.1 authorization server
description: "Every Caller resolves to a Grant, and every credential derives from one: a static bearer token for agents, or OAuth tokens that Modgud itself issues to chat clients after a Pairing code approves the authorization for one Grant on the tailnet-only Approval page."
status: proposed
created: 2026-11-05
modified: 2026-11-06
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

- **A Grant is the managed object.** It is an admin-managed record for one Caller and exactly one Service: a label, `expires_at`, allow and deny Selectors, an optional Identity, and `revoked_at`. Each authorization approved for the Grant records its client and the redirect URI it was approved for. The Grant's expiry caps every credential derived from it, and revoking the Grant ends them all.
- **Credentials derive from the Grant.** A static bearer token is a random secret shown once and stored only as a hash. OAuth tokens are issued by Modgud to a chat client for one Grant.
- **Modgud is its own OAuth 2.1 authorization server.** It serves authorization-server metadata, DCR and CIMD client registration, a token endpoint, and PKCE S256. Access tokens last about one hour, refresh tokens rotate, and the Grant's expiry caps both. Modgud borrows `mcp-stdio`'s OAuth design as a reference and does not fork it.
- **Modgud implements what the MCP authorization spec requires.** A request to a Service without a valid credential gets a 401 whose `WWW-Authenticate` header carries `resource_metadata`. The token endpoint accepts form-urlencoded bodies.
- **Each Service is its own protected resource.** A Service's canonical resource URI is its public `/<service>/mcp` URL, and each Service has its own protected-resource metadata. The `resource` in the authorization request, the code exchange, and every refresh must equal the Grant's Service URI, or Modgud refuses the request. The token's audience is that URI, and Modgud refuses a token presented at another Service's path.
- **An authorization belongs to one Grant, not to a client registration.** A client registration (a DCR or CIMD `client_id`) identifies an application, and one registration can be reused across Grants. Each approved authorization, with the authorization code and the token family that come from it, belongs to the one Grant whose Pairing code approved it. In v1, every authorization request requires a Pairing code.
- **A Pairing code approves one authorization.** An admin mints a single-use code from the Grant, with a lifetime of minutes. The person enters it on the Approval page, which is the `authorization_endpoint`. The page lives on the tailnet-only Admin listener ([ADR-0003](0003-two-listeners-anything-a-person-clicks-lives-on-the-tailnet.md)), so approving a connection requires being on the tailnet. Re-pairing takes a new code.
- **Redirects match exactly, and the Approval page shows them.** Modgud compares `redirect_uri` to the registration's redirect URIs by exact match. The one exception is RFC 8252's loopback rule: an `http` redirect URI on a loopback host matches a registered one that differs only in its port. Registration is open to the internet, and whoever registers a client chooses its name. The Approval page therefore shows the client name and the redirect URI the authorization code will be sent to, before the person enters a Pairing code. That is the `redirect_uri` the request names or, when the request omits it, the client's single registered redirect URI.
- **Selectors filter tools, and deny wins.** `tool:<name>`, `hint:readOnly`, `hint:destructive`, `hint:idempotent`, `hint:openWorld`, and `group:<name>` match tools. With no allow list every tool passes; with one, only matches pass; the deny list then removes matches. Modgud enforces this at `tools/list` and refuses at `tools/call`, because a client can call a hidden tool by name. Modgud never rewrites a tool definition or injects arguments.
- **A `hint:` Selector reads one MCP ToolAnnotations field.** `hint:readOnly` reads `readOnlyHint`, `hint:destructive` reads `destructiveHint`, `hint:idempotent` reads `idempotentHint`, and `hint:openWorld` reads `openWorldHint`. An absent field takes the MCP spec's default. As in the spec, `destructiveHint` and `idempotentHint` count only when the tool is not read-only: `hint:destructive` and `hint:idempotent` never match a tool whose `readOnlyHint` is `true`. An unannotated tool therefore counts as destructive and open-world.
- **A `group:` Selector reads the Service's own Group declaration.** A Service declares Groups in its Tool `_meta` under a Modgud-namespaced key. The proposed shape is `"modgud/groups"` with a list of strings. The exact key and value schema are settled in Phase 2, before Services adopt them. A malformed declaration matches no `group:` Selector.
- **A filtered tool looks absent.** Modgud answers every `tools/call` whose name is not in the Grant's visible tool list, whether the tool is filtered or the Service has no such tool, with one error that Modgud generates itself, and never forwards that call to the Child. The visible tool list is the current `tools/list` result of the Session's own Child with the Grant's Selectors applied, not whatever list the Caller last fetched. A Caller cannot tell a hidden tool from an absent one.
- **One instance on one host.** Modgud is one instance on one host, and every Service runs on that host. Grants live in one SQLite store, with no multi-host coordination. Services live in the config file in v1.
- **Phase 1 runs on a temporary credential harness.** Before the Grant store exists, Phase 1 proves the OAuth flow with one static bearer token from configuration and Pairing codes that `modgud pair` mints into Modgud's store. Pairing codes never live in configuration. `modgud revoke` revokes every OAuth authorization the harness approved, and changing the bearer token's hash revokes the static token. A configured maximum lifetime caps every harness authorization and its tokens, and pairing another client revokes nothing. This decision governs Grant-backed credentials, which arrive in Phase 2. [The OAuth server reference](../oauth.md) specifies the harness's endpoints, limits, and commands. For [ADR-0002](0002-one-child-per-session-identity-enters-through-the-environment.md)'s Session binding, the static token and each harness authorization count as separate Grants, so revoking or expiring one authorization ends the Sessions it opened.

## Considered options

- Static bearer tokens alone, each declaring its Service, expiry, and deny list. Rejected: chat clients cannot use them.
- Adopt `mcp-stdio` or another surveyed product. Rejected: none combines an OAuth server that chat clients accept, Grants, Identity passthrough, and tool filtering. `mcp-stdio` is also Python and limited to one backend.
- Put an identity provider in front, as Cloudflare MCP Portals and Pomerium do. Rejected: they cannot run stdio tools.
- Build authentication into each tool, one decision at a time, as Muninn did. Rejected: each tool would own caller authentication itself, instead of every tool sitting behind one guarded proxy.

## Consequences

Every CLI-based MCP tool becomes reachable from every chat client without owning caller authentication.
Modgud is security-sensitive code: an OAuth server, credential storage, and a public endpoint. A bug exposes tools to the internet.
Its value depends on chat clients keeping their current OAuth behavior, and Modgud must track MCP authorization spec revisions and client quirks. The Phase 1 end-to-end connection from claude.ai and ChatGPT is kept as a repeatable check.
Static bearer tokens for agents are independently justified even if chat-client OAuth never works.
One client registration can hold authorizations for several Grants, and revoking one Grant ends only the tokens that came from that Grant's authorization.
`deny hint:destructive` removes every tool that is not marked `readOnlyHint: true` and does not set `destructiveHint` to `false`, including every unannotated tool.
A malformed Group declaration makes a `group:` allow list fail closed, because the tool is hidden. It makes a `group:` deny list fail open, because the tool passes. An allow list is the safer way to keep a Grant away from tools it must not reach.
Sharp edges to confirm in Phase 1: claude.ai uses only the first `authorization_servers` entry; discovery, registration, and token calls have a 10-second limit; ChatGPT's redirect URI is `https://chatgpt.com/connector_platform_oauth_redirect` or a per-connector callback URL; the `Origin` header behavior of chat clients is unverified.
Open item, after Phase 1 measures client behavior: whether an already-paired client may re-authorize without a Pairing code.
Open item, Phase 1 and Phase 2: abuse limits on the public, unauthenticated registration endpoint and on Pairing code entry, including rate limits, code entropy, and registration cleanup, and on CIMD metadata fetches, which reach a URL the client chooses (HTTPS only; no unspecified, loopback, link-local, private, or tailnet addresses, with the connection pinned to the checked address; size and time limits). Phase 1 settles these for the harness in [the OAuth server reference](../oauth.md); a metadata fetch never follows a redirect, as the Client ID Metadata Document draft requires.
Open item, Phase 2: Selectors filter tools only. How Modgud handles `resources/*` and `prompts/*` for a Grant with Selectors is settled before such Grants ship.
Open item, Phase 2: credential cardinality per Grant, meaning several static tokens for rotation, a static token alongside OAuth, and what re-pairing does to an earlier authorization.
Open item, Phase 2: authentication of the admin API and panel on the tailnet, with a Tailscale `whois` allowlist for the panel and an admin token for the CLI.
Open item, Phase 1: whether ChatGPT opens the tailnet-only Approval page in the browser.
Open item, Phase 1 and later: Claude Duet, ChatGPT Dot, Grokbot, and Meta Muse were named as targets, but their auth support is unverified.

## Changelog

- 2026-11-05: Proposed. It becomes accepted as the code it governs lands.
- 2026-11-06: Addendum. Settled the Phase 1 harness as the OAuth server landed: `modgud pair` mints Pairing codes into the store instead of configuration, `modgud revoke` revokes OAuth authorizations, loopback redirect URIs match on any port, and a client metadata fetch never follows a redirect, and each harness authorization binds its own Sessions. It stays proposed until Phase 2's Grants land.
