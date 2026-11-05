# Modgud

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Modgud is an MCP auth proxy. It runs local stdio MCP servers, one child process per MCP session, and serves them as Streamable HTTP MCP endpoints that a tunnel such as Cloudflare Tunnel can expose. Modgud is its own OAuth 2.1 authorization server, so chat clients such as Claude and ChatGPT can connect. It maps every caller to a Grant, which sets the target service, the expiry, the tool allow and deny selectors, and the identity that Modgud passes to the tool.

Status: shaped, not yet in build. Phase 1 proves the OAuth flow with real chat clients.

## Plan

Modgud is built in four phases:

- Phase 1, crux test: Norn served over Streamable HTTP, then the OAuth server proven with claude.ai and ChatGPT.
- Phase 2, Grants: the Grant store, Selectors, revocation, the admin API and CLI, and the audit log.
- Phase 3, Identity: Mimir served with the Grant's Identity.
- Phase 4, admin panel: tailnet pages for Grants, pairing, live Sessions, and the audit log.
