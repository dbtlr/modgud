---
description: The contract of Modgud's OAuth 2.1 authorization server in Phase 1 — its endpoints, metadata, flows, tokens, limits, store, and commands — that chat clients and the code build against.
---

# OAuth server

Modgud is its own OAuth 2.1 authorization server ([ADR-0001](decisions/0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md)). Chat clients such as claude.ai and ChatGPT find it from a Service's 401, register, send a person to the Approval page on the tailnet, and then call the Service with an access token. This document is the contract for Phase 1, which runs on the temporary credential harness: every credential it issues counts as a credential of one Grant, and that Grant covers the one Service that `harness.service` names.

It follows the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), OAuth 2.1, RFC 8414 (server metadata), RFC 9728 (protected-resource metadata), RFC 7591 (dynamic registration), RFC 8707 (resource indicators), RFC 9207 (issuer in the authorization response), RFC 8252 (loopback redirects), and the [Client ID Metadata Document draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/). Where this document is stricter than those, this document holds.

## Addresses

Two configured base URLs name every URL below. Each is an `https` URL with no path, query, or fragment.

- `public.base_url` is the address callers use through the tunnel. It is the `issuer`, and a Service's resource URI is `<public.base_url>/<service>/mcp`.
- `admin.base_url` is the HTTPS address of the Admin listener on the tailnet, served by a TLS-terminating proxy ([ADR-0003](decisions/0003-two-listeners-anything-a-person-clicks-lives-on-the-tailnet.md)). The `authorization_endpoint` is `<admin.base_url>/authorize`.

## Public listener endpoints

Every response from these endpoints carries `Cache-Control: no-store`. Any other path, and any other method on these paths, gets HTTP 404 or 405.

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

Modgud has no scopes, so the metadata lists none. Every client is a public client: it authenticates with PKCE, never with a secret.

### Service endpoints

`/<service>/mcp` accepts the harness's static bearer token ([README](../README.md)) or an access token whose resource is that Service's URI. A request without a valid credential gets HTTP 401 with:

```
WWW-Authenticate: Bearer resource_metadata="<public.base_url>/.well-known/oauth-protected-resource/<service>/mcp"
```

When the request carried a bearer token that is not valid here (unknown, expired, revoked, or issued for another Service), the header also carries `error="invalid_token"`. Everything else about Sessions is [ADR-0002](decisions/0002-one-child-per-session-identity-enters-through-the-environment.md).

### Dynamic client registration

`POST /oauth/register` takes an RFC 7591 JSON body of at most 16 KiB.

- `redirect_uris` is required: 1 to 10 URIs, each at most 2,048 characters. Each is an absolute `https` URI, or an `http` URI whose host is `127.0.0.1`, `[::1]`, or `localhost`. None has a fragment.
- `client_name` is optional, at most 100 characters. Without one, the Approval page shows "Unnamed client".
- `grant_types`, when present, must include `authorization_code`; `response_types`, when present, must include `code`.
- Any requested `token_endpoint_auth_method` is accepted and registered as `none`, and the response says so.
- Every other field is ignored and not echoed.

A valid request gets HTTP 201 with `client_id` (a random identifier), `client_id_issued_at`, `client_name` when given, `redirect_uris`, `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`, and `token_endpoint_auth_method: "none"`. There is no `client_secret`. An invalid request gets HTTP 400 with `invalid_redirect_uri` or `invalid_client_metadata`.

Registration is open to the internet, so it is bounded:

- At most 20 registrations in any 10 minutes, across all callers. Past that, HTTP 429 with `Retry-After`.
- At most 500 stored registrations. Past that, HTTP 429.
- A registration with no approved authorization is deleted 24 hours after it was made.

### Token endpoint

`POST /oauth/token` takes `application/x-www-form-urlencoded` bodies of at most 16 KiB. A successful answer is HTTP 200:

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "…" }
```

`expires_in` is shorter when the authorization expires sooner. Errors are RFC 6749 JSON with HTTP 400 (`invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_target`).

`grant_type=authorization_code` requires `code`, `client_id`, `code_verifier`, `redirect_uri`, and `resource`.

- The code must be unspent and unexpired, and must have been issued to this `client_id` for this `redirect_uri`, with `S256(code_verifier)` equal to its `code_challenge`.
- `resource` must equal the code's resource.
- Presenting a code that was already spent revokes the authorization it came from, with every token issued from it.

`grant_type=refresh_token` requires `refresh_token`, `client_id`, and `resource`.

- The refresh token must be the current one of its authorization, issued to this `client_id`, and `resource` must equal the authorization's resource.
- Each refresh returns a new access token and a new refresh token, and the old refresh token stops working in the same step.
- Presenting a refresh token that was already rotated away revokes its authorization, with every token issued from it.

An unknown or mismatched `client_id` gets `invalid_client`. An unknown, spent, expired, or revoked code or refresh token gets `invalid_grant`. A wrong `resource` gets `invalid_target`.

## Admin listener endpoints

The Admin listener serves only `/authorize`. Every other path gets HTTP 404. Its pages carry `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`. Every value a client supplied is HTML-escaped.

### Approval page

`GET /authorize` takes `response_type=code`, `client_id`, `redirect_uri` (optional when the client has exactly one), `code_challenge`, `code_challenge_method=S256`, `resource`, `state` (optional), and `scope` (optional, ignored).

1. Modgud resolves the client, by registration or, when `client_id` is an `https` URL, by its metadata document (below), and matches `redirect_uri` against the client's redirect URIs. If either fails, the page shows the error and never redirects.
2. Any other problem redirects to the redirect URI with `error`, `state`, and `iss`: `unsupported_response_type`, `invalid_request` (a missing or non-S256 challenge), or `invalid_target` (a `resource` that is not `<public.base_url>/<harness.service>/mcp`).
3. Otherwise Modgud records a pending request, valid for 10 minutes, and shows the Approval page: the client's name, where it comes from (the `client_id` URL's host for a metadata document, "registered dynamically" otherwise), the Service, and the exact redirect URI the code will go to. A loopback redirect URI carries a warning that the code goes to a program on the approving device. The page has a field for the Pairing code and Approve and Deny buttons. The form carries the pending request's random identifier and nothing else from the request.

**Redirect matching.** A redirect URI matches by exact string comparison. The only exception is RFC 8252 loopback: an `http` redirect URI on `127.0.0.1`, `[::1]`, or `localhost` matches a registered one that differs only in its port.

`POST /authorize` takes the pending request's identifier, the action, and, to approve, the Pairing code.

- **Deny** redirects with `error=access_denied`, `state`, and `iss`, and ends the pending request.
- **Approve with a valid code** spends the code, creates the authorization, issues an authorization code, and redirects with `code`, `state`, and `iss`. The pending request ends.
- **Approve with a wrong, expired, or spent code** shows the page again with an error. The fifth failure ends the pending request, and the person starts over from the client.
- **Throttle.** After 20 failed codes in any 10 minutes, across all pending requests, the page refuses every code for 10 minutes. It counts as a failure without checking the code.

A Pairing code is entered as eight characters from Crockford's base32 alphabet, about 40 bits. Case, spaces, and hyphens do not matter, and `I`, `L`, and `O` read as `1`, `1`, and `0`.

### Client metadata documents

A `client_id` that is an `https` URL names a Client ID Metadata Document. The URL must have a path other than `/` and no userinfo, query, fragment, or `.` or `..` segment. Modgud compares it as a plain string.

Modgud fetches it only at `GET /authorize`, and fetches it safely:

- `https` only. Every address the host resolves to must be a public unicast address. Modgud refuses the special-use ranges of RFC 6890, including unspecified, loopback, private, link-local, shared (100.64.0.0/10, which holds tailnet addresses), unique-local (fc00::/7), multicast, documentation, and benchmarking addresses, and IPv4-mapped forms of any of them.
- The connection goes to an address that passed the check, with the TLS server name and `Host` set to the URL's host. DNS is not consulted again for that connection.
- Modgud never follows a redirect. A response other than HTTP 200 fails.
- The request sends `Accept: application/json`. The response must arrive within 5 seconds and be at most 10 KiB.
- At most 30 fetches in any minute, across all clients.

The document must be a JSON object whose `client_id` equals the URL, with `client_name` and `redirect_uris` under the same rules as registration. When it declares `token_endpoint_auth_method`, the value must be `none`. A document with `client_secret` fails. Modgud keeps a valid document for its `Cache-Control` `max-age`, clamped to between 5 minutes and 24 hours (1 hour when absent), and never keeps a failure.

## Tokens and authorizations

An **authorization** is one approved connection: a client, the redirect URI it was approved for, the Service's resource URI, and when it was approved. It expires `harness.max_token_lifetime_days` after approval (30 by default), and every token issued from it expires no later.

- An authorization code is single-use and lasts 60 seconds.
- An access token lasts 1 hour. Its audience is the authorization's resource, and Modgud refuses it at any other Service's path.
- An authorization has one current refresh token at a time, and it rotates on every use.
- Tokens are random strings of 32 bytes. Access tokens start with `mdg_at_` and refresh tokens with `mdg_rt_`, so secret scanners can find them.

Every authorization stays until it expires or is revoked, so pairing a second client never affects the first.

## Store

Modgud keeps registrations, unspent Pairing codes, pending requests, authorizations, authorization codes, and tokens in one SQLite database at `store.path`. Every Pairing code, authorization code, and token is stored only as its SHA-256 hash. Modgud creates the file with mode 0600 and its directory with mode 0700. The server reads the store on every request, so a change that `modgud pair` or `modgud revoke` writes takes effect on the next request, without a restart. Everything in the store survives a restart.

## Commands

- `modgud pair` mints a Pairing code, stores its hash with an expiry, and prints the code and when it expires. A code lasts 10 minutes, or `--minutes` from 1 to 60. It approves exactly one authorization.
- `modgud revoke` deletes every authorization, with every authorization code and token issued from it, and every unspent Pairing code. It prints how many authorizations it revoked. Requests on open Sessions that carry a revoked token get HTTP 401 from then on. The static bearer token is revoked by changing its hash in the configuration and restarting.

Both commands read the same configuration file as `modgud serve` and act on its store, so they run as the OS account that runs Modgud.

## Open items for the end-to-end proof

- Whether claude.ai sends `resource`. Modgud requires it, as the MCP specification does.
- Whether ChatGPT's metadata document declares `none` or `private_key_jwt`. Modgud accepts only `none`.
- Whether a client retries a refresh after a lost response. Strict rotation then revokes the authorization, and the person pairs again.
