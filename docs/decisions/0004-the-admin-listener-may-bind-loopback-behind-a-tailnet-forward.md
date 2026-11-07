---
type: adr
title: ADR-0004 - The Admin listener may bind loopback behind a tailnet forward
description: "The Admin listener binds a tailnet address, or loopback when a tailnet forward such as `tailscale serve` puts it on the tailnet. This replaces ADR-0003's rule that it binds a tailnet address only; the rest of ADR-0003 stands."
status: accepted
created: 2026-11-07
modified: 2026-11-07
---

# The Admin listener may bind loopback behind a tailnet forward

## Context

ADR-0003 requires the Admin listener to bind a tailnet address, and Modgud refuses any other. Hosts that run several services commonly bind each one to loopback and publish it on the tailnet with `tailscale serve`, which forwards a tailnet port to a loopback port. On such a host, `tailscale serve` already holds the tailnet address and port, so a listener that must bind the tailnet address itself cannot start in that layout.

## Decision

- The Admin listener binds a tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48) or a loopback address (`127.0.0.1`, `::1`, or `localhost`). Modgud refuses any other.
- A loopback Admin listener is reached through a tailnet forward, such as `tailscale serve`, that the operator configures. The TLS-terminating proxy in front of `admin.base_url` reaches it through that forward and passes the `Host` header through, as ADR-0003 requires.
- This replaces only ADR-0003's binding rule. Its principle stands: anything a person clicks lives on the tailnet. The two-listener split, the `Host` check, and taking public addresses from configuration are unchanged.

## Considered options

- Keep tailnet-only binding and move the Admin listener to a port no forward holds. Rejected: it works against the host's convention, and the convention's forward must be removed by hand.
- Bind any address. Rejected: a wildcard or LAN address would put the Approval page beyond the tailnet.

## Consequences

On loopback, the guarantee that the Approval page is reachable only from the tailnet comes from the operator's forward, not from Modgud's bind. Modgud cannot tell whether the forward exists or is tailnet-only. Any local process on the host can reach a loopback Admin listener, as it can the Public listener. That is within the trust boundary ADR-0002 sets at the OS account. The Approval page still requires a Pairing code, and it refuses any `Host` but `admin.base_url`'s.

The Admin listener sees the forward's address as every request's peer. Nothing on it depends on the peer address: the Pairing-code throttle counts failures across all requests.

## Changelog

- 2026-11-07: Accepted, with the configuration change that enforces it.
