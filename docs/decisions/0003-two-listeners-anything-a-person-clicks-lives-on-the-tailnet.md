---
type: adr
title: ADR-0003 - Two listeners split the public surface from everything a person clicks
description: "The Public listener binds localhost behind cloudflared and serves only the MCP endpoints and the OAuth endpoints chat-client servers call. The Admin listener binds the tailnet only and serves the Approval page, the admin API, and the admin panel."
status: proposed
created: 2026-11-05
modified: 2026-11-05
---

# Two listeners split the public surface from everything a person clicks

## Context

Modgud must be reachable from chat-client servers on the internet, through a Cloudflare Tunnel, while its admin functions must not be. A bug in the public surface exposes tools to the internet, so that surface should be as small as the OAuth flow allows.

Anthropic's tunnel OAuth documentation publishes an example with `authorization_endpoint` on a different host than the issuer. It states "the member's browser is redirected to the authorization endpoint… it must be a URL their browser can load" ([source](https://claude.com/docs/connectors/mcp-tunnels/oauth)). The metadata and token endpoints, by contrast, are called by Anthropic's servers and must be reachable from its egress range. ChatGPT's browser behavior is implied by its redirect flow but not confirmed.

## Decision

- **Public listener.** It binds localhost and is reached only by cloudflared. It serves `/<service>/mcp` (Streamable HTTP), OAuth protected-resource and authorization-server metadata, client registration (DCR), and the token endpoint.
- **Admin listener.** It binds the tailnet interface only. It serves the OAuth `authorization_endpoint` (the Approval page, where the Pairing code is entered), the admin API, and the admin panel.
- **Principle: anything a person clicks lives on the tailnet.** The Public listener serves only what chat-client servers call and cannot reach the Admin listener's routes. Approving a connection requires being on the tailnet.

## Considered options

- One listener serving everything behind the tunnel. Rejected: the Approval page and admin API would be reachable from the internet, guarded only by application checks.
- Put an identity provider in front of the whole proxy, as Cloudflare MCP Portals and Pomerium do. Rejected: those products put an identity provider in front but cannot run stdio tools.

## Consequences

An approver must be on the tailnet to pair a chat client. Pairing from a phone off the tailnet does not work.
The split depends on chat clients loading the approval URL in the person's browser. If either claude.ai or ChatGPT rejects the split-host Approval page, the design changes before any Grant work exists, so Phase 1 tests this first.
The admin API and panel also need their own authentication on the tailnet, settled in Phase 2: a Tailscale `whois` allowlist for the panel and an admin token for the CLI. The CLI reads the admin URL from configuration, so an agent on any tailnet host can manage Grants.
The panel's pages (Grants, pairing, live Sessions, the audit log) arrive in Phase 4.
Open item, Phase 1: how the Admin listener gets TLS for the authorization endpoint, from `tailscale cert`, Tailscale Serve, or a private CA.
Open item, Phase 1: the configured public base URL that the Public listener uses for `issuer`, resource URIs, and metadata, because it sees plain HTTP from cloudflared.

## Changelog

- 2026-11-05: Proposed. It becomes accepted as the Phase 1 code lands.
- 2026-11-05: Revised while proposed. The identity-provider option keeps only its sourced reason, and TLS and the public base URL are recorded as open items.
