---
description: The contract of Modgud's OAuth 2.1 authorization server in Phase 1 — its endpoints, metadata, flows, tokens, limits, store, and commands — that chat clients and the code build against.
---

# OAuth server

Modgud is its own OAuth 2.1 authorization server ([ADR-0001](decisions/0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)). Chat clients such as claude.ai and ChatGPT find it from a Service's 401, register, send a person to the Approval page on the tailnet, and then call the Service with an access token. This document is the contract for Phase 1, which runs on the temporary credential harness: it issues credentials only for the one Service that `harness.service` names.

It follows the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), OAuth 2.1, RFC 8414 (server metadata), RFC 9728 (protected-resource metadata), RFC 7591 (dynamic registration), RFC 7636 (PKCE), RFC 8707 (resource indicators), RFC 9207 (issuer in the authorization response), RFC 8252 (loopback redirects), RFC 9700 (security best practice), and the [Client ID Metadata Document draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/). Where this document is stricter than those, this document holds.

## Addresses

Two configured base URLs name every URL below. Each is an `https` URL with a lowercase ASCII host (punycode for an international name), no explicit default port, no path, no trailing slash, no query, and no fragment, and Modgud uses each as the exact string configured. It never rebuilds them from a request's `Host` header.

- `public.base_url` is the address callers use through the tunnel. It is the `issuer`, the one entry of `authorization_servers`, and the `iss` of every authorization response, all as the same string. A Service's resource URI is `<public.base_url>/<service>/mcp`.
- `admin.base_url` is the HTTPS address of the Admin listener on the tailnet, served by a TLS-terminating proxy that passes the `Host` header through ([ADR-0003](decisions/0003-two-listeners-anything-a-person-clicks-lives-on-the-tailnet.md)). The `authorization_endpoint` is `<admin.base_url>/authorize`.

## Public listener endpoints

Every response from these endpoints carries `Cache-Control: no-store`. Any other path gets HTTP 404, and any other method on these paths gets HTTP 405. Modgud serves no CORS headers: its callers are chat-client servers and native programs, and browser-based clients are not supported.

### Protected-resource metadata

`GET /.well-known/oauth-protected-resource/<service>/mcp` answers, for each configured Service:

```json
{
  "resource": "<public.base_url>/<service>/mcp",
  "authorization_servers": ["<public.base_url>"],
  "bearer_methods_supported": ["header"]
}
```

The root form `/.well-known/oauth-protected-resource` gets HTTP 404: each Service is its own protected resource, and the 401 names the right document.

### Authorization-server metadata

`GET /.well-known/oauth-authorization-server` answers:

```json
{
  "issuer": "<public.base_url>",
  "authorization_endpoint": "<admin.base_url>/authorize",
  "token_endpoint": "<public.base_url>/oauth/token",
  "registration_endpoint": "<public.base_url>/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true
}
```

Modgud has no scopes, so the metadata lists none. Every client is a public client: PKCE proves it, never a secret.

### Service endpoints

`/<service>/mcp` accepts the harness's static bearer token ([README](../README.md)) or an access token whose resource is that Service's current URI. A request without a valid credential gets HTTP 401 with:

```
WWW-Authenticate: Bearer resource_metadata="<public.base_url>/.well-known/oauth-protected-resource/<service>/mcp"
```

When the request carried a bearer token that is not valid here (unknown, expired, revoked, or issued for another Service), the header also carries `error="invalid_token"`.

A Session is bound to the credential source that opened it: the static token, or one authorization. A request on the Session that carries a valid credential from any other source gets the same HTTP 404 as an unknown Session ([ADR-0002](decisions/0002-one-child-per-session-identity-enters-through-the-environment.md)). When an authorization is revoked or expires, Modgud ends every Session bound to it, with its open streams and its Child, within 10 seconds, including when `modgud revoke` made the change.

### Dynamic client registration

`POST /oauth/register` takes an RFC 7591 JSON body of at most 16 KiB.

- `redirect_uris` is required: 1 to 10 URIs, each at most 2,048 characters. Each is an absolute `https` URI whose host is a domain name of letters, digits, and hyphens, with no label starting or ending in a hyphen, no label over 63 characters, and no trailing dot, or an `http` URI whose host is `127.0.0.1`, `[::1]`, or `localhost`. None has a fragment or userinfo.
- `client_name` is optional, at most 100 characters.
- `grant_types`, when present, must include `authorization_code`; `response_types`, when present, must include `code`.
- Any requested `token_endpoint_auth_method` is accepted and registered as `none`, and the response says so. A requested `scope` is ignored.
- Every other field is ignored and not echoed.

A valid request gets HTTP 201 with `client_id`, `client_id_issued_at`, `client_name` when given, `redirect_uris`, `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`, and `token_endpoint_auth_method: "none"`. There is no `client_secret`. An invalid request gets HTTP 400 with `invalid_redirect_uri` or `invalid_client_metadata`.

Registration is open to the internet, so it is bounded. A request's source is the `CF-Connecting-IP` header, which cloudflared sets, or the peer address when the header is absent. An IPv6 source counts by its /64 prefix.

- At most 10 registrations from one source, and 100 overall, in any 10 minutes. Past either, HTTP 429 with `Retry-After`.
- At most 500 stored registrations. A new registration past that evicts the oldest registration with no live authorization, never-approved ones first. When every stored registration has a live authorization, the new one gets HTTP 503.
- A registration that has never been approved is deleted 1 hour after it was made. A registration that has been approved is kept, so a client can pair again with the `client_id` it holds, unless the cap evicts it.

### Token endpoint

`POST /oauth/token` takes `application/x-www-form-urlencoded` bodies of at most 16 KiB. A successful answer is HTTP 200:

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "…" }
```

`expires_in` is shorter when the authorization expires sooner. Errors are RFC 6749 JSON with HTTP 400. `client_assertion`, `client_assertion_type`, and `client_secret` are ignored: every client is public.

`grant_type=authorization_code` requires `code`, `client_id`, and `code_verifier`.

- The code must be unspent, unexpired, and issued to this `client_id`, and `S256(code_verifier)` must equal its `code_challenge`. `code_verifier` is 43 to 128 characters from RFC 7636's unreserved set.
- `redirect_uri` is required when the authorization request carried one, and must then equal it exactly, port included.
- `resource`, when present, must equal the code's resource.

`grant_type=refresh_token` requires `refresh_token` and `client_id`.

- The refresh token must be the current one of its authorization and issued to this `client_id`. `resource`, when present, must equal the authorization's resource.
- Each refresh returns a new access token and a new refresh token, and the presented refresh token stops working in the same transaction.

Errors:

- `invalid_request` for a missing or malformed parameter, and `unsupported_grant_type` for any other grant.
- `invalid_client` only when `client_id` names no client.
- `invalid_grant` for an unknown, spent, expired, or revoked code or refresh token, a wrong `code_verifier` or `redirect_uri`, or a code or refresh token issued to another client.
- `invalid_target` for a `resource` that does not match.

**Replay.** Presenting a spent authorization code revokes the authorization it came from, with every token issued from it, and gets `invalid_grant`. Every refresh token names its authorization's family (below), so Modgud recognizes any refresh token the authorization ever issued. When a refresh token of the family that is not the current one arrives with the family's `client_id`, it is a replay: Modgud revokes the authorization, with every token issued from it, and answers `invalid_grant`. Rotation is strict, as RFC 9700 §4.14.2 recommends. Modgud cannot tell a client retrying after a lost response from a thief replaying a stolen token, so it treats both as theft.

## Admin listener endpoints

The Admin listener serves only `/authorize`. Every other path gets HTTP 404.

- A request whose `Host` header is not the host and port of `admin.base_url`, exactly as configured, gets HTTP 421. This keeps a page that rebinds its own name to the listener's address, tailnet or loopback, from reading or driving the listener.
- Its pages carry `Cache-Control: no-store`, `Referrer-Policy: same-origin`, and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self' <the redirect URI's origin>; frame-ancestors 'none'`. The redirect URI's origin is listed so the browser follows the redirect after Approve or Deny. CSP cannot name an IP-literal host, so when the redirect URI's host is an IP address, the policy leaves out `form-action`. `same-origin` keeps the `Origin` header on the page's own form POST, which `no-referrer` would turn into `null`, and sends no `Referer` to the client.
- Every value a client supplied is HTML-escaped. Host names are shown in their ASCII (punycode) form, and control and bidirectional-formatting characters are removed from every shown value.

### Approval page

`GET /authorize` takes `response_type=code`, `client_id`, `redirect_uri` (optional when the client has exactly one), `code_challenge`, `code_challenge_method=S256`, `resource` (optional), `state` (optional, at most 1,024 characters), and `scope`. The query string is at most 8 KiB.

1. Modgud resolves the client, by registration or, when `client_id` is an `https` URL, by its metadata document (below), and matches `redirect_uri` against the client's redirect URIs.
2. It checks the rest: `response_type` is `code`; `code_challenge` is 43 characters of base64url and the method is `S256`; `scope` is absent or empty; and `resource`, when present, equals `<public.base_url>/<harness.service>/mcp`. An absent `resource` means that URI.
3. A failure in step 1 shows an error page and never redirects. An unknown `client_id` page tells the person to remove the connector from the client and add it again.
4. A failure in step 2 shows an error page that names the redirect URI's host and offers a "Return to <host>" link carrying the OAuth error (`unsupported_response_type`, `invalid_request`, `invalid_scope`, or `invalid_target`), `state`, and `iss`. It never redirects on its own, so the Admin listener's address cannot bounce a person to a site the client chose.
5. Otherwise Modgud holds a pending request in memory for 10 minutes and shows the Approval page. It holds at most 50 pending requests and drops the oldest past that.

Modgud creates a pending request, or fetches a metadata document, only for a top-level browser navigation: a request with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`, or one with no `Sec-Fetch-` headers at all, which browsers older than Safari 16.4 send. Any other `GET /authorize` gets an error page, so a page elsewhere cannot fill the pending requests or spend the fetch budget with hidden requests.

The Approval page leads with the host the code will be sent to, then shows the exact redirect URI, the Service, and the client's name, labeled as chosen by the client. For a metadata document it also shows the `client_id` URL's host, and warns when the redirect URI's host differs from it. A loopback redirect URI carries a warning that the code goes to a program on the approving device. The page has a field for the Pairing code and Approve and Deny buttons.

The response sets a cookie for that pending request, named `__Host-modgud-pending-` followed by the first 8 characters of its identifier (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, `Max-Age=600`), holding a random value bound to it. Several pending requests in different tabs do not overwrite each other's cookies. The form carries the pending request's random identifier and nothing else from the request.

**Redirect matching.** A redirect URI matches by exact string comparison. The only exception is RFC 8252 loopback: an `http` redirect URI on `127.0.0.1`, `[::1]`, or `localhost` matches a registered one that differs only in its port.

`POST /authorize` takes the pending request's identifier, the action, and, to approve, the Pairing code. Modgud refuses it with HTTP 403, without counting a failure, unless its `Origin` header equals `admin.base_url` and its cookie matches the pending request. An unknown or expired pending request shows an error page and does not count as a failure.

- **Deny** ends the pending request and redirects with HTTP 303 to the redirect URI with `error=access_denied`, `state`, and `iss`. The person has just seen that host on the page.
- **Approve with a valid code** spends the code, creates the authorization, and issues an authorization code in one transaction, then redirects with HTTP 303 to the redirect URI with `code`, `state`, and `iss`. The pending request ends. HTTP 303 makes the browser follow with a GET, so the form body never reaches the client.
- **Approve with a wrong, expired, or spent code** shows the page again with an error. The fifth failure ends the pending request, and the person starts over from the client.
- **Throttle.** After 20 failed codes in any 10 minutes, across all pending requests, the page refuses every code until that window has fewer than 20. A refused attempt neither checks the code nor counts as a failure.

A Pairing code is entered as eight characters from Crockford's base32 alphabet, 40 bits. Case, spaces, and hyphens do not matter, and `I`, `L`, and `O` read as `1`, `1`, and `0`.

### Client metadata documents

A `client_id` that is an `https` URL names a Client ID Metadata Document. The URL must use port 443, have a path other than `/`, and have no userinfo, query, fragment, or `.` or `..` segment. It must also be written the way a URL parser writes it, with a lowercase scheme and host and no explicit port, so `https://example.com:443/client.json` is refused. Modgud compares it as a plain string.

Modgud fetches it only at `GET /authorize`, and fetches it safely:

- `https` on port 443 only, ignoring any proxy settings in Modgud's environment.
- Every address the host resolves to must be a public unicast address. Modgud refuses the special-use ranges of RFC 6890, including unspecified, loopback, private, link-local, shared (100.64.0.0/10, which holds tailnet addresses), unique-local (fc00::/7), multicast, documentation, and benchmarking addresses; the NAT64 prefixes 64:ff9b::/96 and 64:ff9b:1::/48; IPv4-mapped and IPv4-compatible forms of any refused address; and every address of the host's own interfaces.
- The connection goes to an address that passed the check, with the TLS server name and `Host` set to the URL's host. DNS is not consulted again for that connection.
- Modgud never follows a redirect. A response other than HTTP 200 fails.
- The request sends `Accept: application/json`. The response must arrive within 5 seconds and be at most 10 KiB.
- At most 30 fetches in any minute, across all clients.
- A failed fetch shows one generic error that does not say why it failed.

The document must be a JSON object whose `client_id` equals the URL, with `client_name` and `redirect_uris` under the same rules as registration. It must allow a public client: when it lists `token_endpoint_auth_methods_supported`, the list must include `none`; otherwise `token_endpoint_auth_method`, when present, must be `none`. A document with `client_secret` fails. Modgud keeps up to 100 valid documents, each for its `Cache-Control` `max-age` clamped to between 5 minutes and 24 hours (1 hour when absent), and never keeps a failure.

## Tokens and authorizations

An **authorization** is one approved connection: a client, the redirect URI it was approved for, the Service's resource URI, and when it was approved. It expires `harness.max_token_lifetime_days` after approval, using the value configured now, and every token issued from it expires no later. An authorization whose resource is no longer the current harness Service's URI is no longer valid. Every authorization stays until it expires or is revoked, so pairing a second client never affects the first.

- An authorization code is single-use and lasts 60 seconds.
- An access token lasts 1 hour. Its audience is the authorization's resource, and Modgud refuses it at any other Service's path. An authorization keeps at most its 5 newest access tokens; an older one stops working.
- An authorization has one current refresh token at a time, and it rotates on every use.
- Tokens, authorization codes, client identifiers, pending-request identifiers, and cookie values are 32 random bytes, base64url-encoded. Access tokens start with `mdg_at_`, so secret scanners can find them.
- A refresh token is `mdg_rt_`, then the family, then `.`, then the secret: 94 characters. The family is a random 32-byte identifier of its authorization that appears only in that authorization's refresh tokens, so only a holder of one of them can name it. A refresh token of any other length or shape is unknown. Modgud stores the family and the hash of the current refresh token, nothing more.

Every single-use step is atomic: spending a Pairing code, spending an authorization code, and rotating a refresh token each succeed for at most one request, even when requests race. A token is valid only while its authorization exists, so a token issued while `modgud revoke` runs does not survive it.

## Store

Modgud keeps registrations, unspent Pairing codes, authorizations, authorization codes, and tokens in one SQLite database at `store.path`. Every Pairing code, authorization code, and token is stored only as its SHA-256 hash; a refresh token's family is stored as is. Expired rows are deleted at least hourly. A spent authorization code is kept while its authorization lives, so a replay of it is still detected. The server reads the store on every request, so a change that `modgud pair` or `modgud revoke` writes takes effect on the next request, without a restart. Everything in the store survives a restart; pending requests, which live in memory, do not.

Whenever Modgud or a command opens the store, it checks the store's directory and file before reading. It refuses to start when `store.path` is a symbolic link. It creates an absent directory with mode 0700. It refuses to start when an existing directory is writable by group or others, or owned by another account. It sets the file, and SQLite's `-wal`, `-shm`, and `-journal` files beside it, to mode 0600, logging a warning when an existing mode was wider, and refuses to start when it cannot.

## Logging

Modgud never logs a Pairing code, an authorization code, a token, a refresh-token family, an `Authorization` header, or a `Location` header. It logs registrations, approvals, denials, failed Pairing codes, the Pairing code throttle, metadata fetch limits, replay revocations, and `modgud revoke`. It logs each Session open with the caller, the `Origin` header, and the protocol revision the caller requested. It logs a request refused for its `Origin` only when its credential is valid. It logs each token issue, with whether the request sent `resource`. It names a registered client and an authorization by a short prefix of their identifiers, and a metadata-document client by its host. Refused registrations are not logged, and neither are refused `Origin` headers from unauthenticated requests, so a flood cannot fill the log. A request that fails unexpectedly gets a plain HTTP 500, and the log names the error without a stack trace.

## Commands

- `modgud pair` mints a Pairing code, stores its hash with an expiry, and prints the code and when it expires. A code lasts 10 minutes, or `--minutes` from 1 to 60. It approves exactly one authorization.
- `modgud revoke` deletes every authorization, with every authorization code and token issued from it, and every unspent Pairing code. Registrations stay. It prints how many authorizations it revoked. The server ends the Sessions bound to them within 10 seconds. The static bearer token is revoked by changing its hash in the configuration and restarting.

Both commands read the same configuration file as `modgud serve` and act on its store, so they run as the OS account that runs Modgud.

## Limitations

- The Admin listener checks that `admin.host` is a tailnet address by range, or loopback. 100.64.0.0/10 is also carrier-grade NAT space, so on a host whose uplink uses it, a misconfigured `admin.host` could bind the uplink. The Approval page there still requires a Pairing code.
- On loopback, the Admin listener is on the tailnet only through the forward the operator configures in front of it, such as `tailscale serve`. Modgud cannot check that the forward exists or is limited to the tailnet.
- Browser-based MCP clients cannot connect, because Modgud serves no CORS headers.
- A client that rejects a scopeless server, or always sends a nonempty `scope`, cannot connect.
- An attacker with many source addresses can keep the overall registration limit full, which blocks dynamic registration. Connections that use a metadata document are unaffected. claude.ai and ChatGPT use one when Modgud advertises it, unless a connection is set up for dynamic registration.
- Any device on the tailnet can reach the Admin listener directly and trip the failed-code throttle, which pauses pairing for 10 minutes at a time.
- A page the approver opens can open a window and navigate it to `/authorize` repeatedly, which passes as top-level navigation. That can fill the pending requests and spend the metadata fetch budget while the page stays open.
- A client that presents a refresh token it or another of its processes already used, as after a lost refresh response or two refreshes at once, revokes its own authorization, and the person pairs again.

## Observed client behavior

Observed on 2026-11-07, with claude.ai and ChatGPT developer mode each connected through the tunnel, paired on the Approval page, and calling a Service tool:

- Both identify themselves with a Client ID Metadata Document (`https://claude.ai/…` and `https://chatgpt.com/…`), not dynamic registration.
- Both open the authorization endpoint on `admin.base_url` in the person's browser, so the split between the issuer and the Approval page works for both.
- Both send `resource` when they exchange the authorization code.
- Neither sends an `Origin` header when it opens a Session, and with the default empty `public.allowed_origins` no request from either was refused for its `Origin`.
- Both request protocol revision `2025-11-25` in `initialize`.
- Neither ended a Session during the five minutes observed. claude.ai opened two when it connected. ChatGPT opened five within about a minute, in bursts of two, two, and one. Each Session keeps its Child until the idle timeout, 30 minutes by default, so at that rate ordinary ChatGPT use would reach the default `public.max_sessions` of 16 within minutes.

Not yet observed: how either client refreshes under strict rotation, including whether it retries or races a refresh, and how it recovers when a restart ends its Sessions.
