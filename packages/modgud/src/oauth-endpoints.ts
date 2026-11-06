import { clientLabel, isClientIdMetadataUrl, parseClientMetadata } from './client-metadata.ts';
import { serviceResource } from './config.ts';
import type { Config } from './config.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import { isCodeVerifier } from './pkce.ts';
import { createWindowLimit, sourceKey } from './rate-limit.ts';
import type { Store, TokenResult } from './store.ts';

// The Public listener's OAuth endpoints (docs/oauth.md, "Public listener
// endpoints"): both metadata documents, dynamic client registration, and the
// token endpoint. Every URL they name comes from the configured base URLs,
// never from the request.

// The largest registration or token request body, in bytes.
const BODY_LIMIT = 16 * 1024;

const REGISTRATION_WINDOW_MS = 10 * 60_000;
const REGISTRATIONS_PER_SOURCE = 10;
const REGISTRATIONS_OVERALL = 100;

const PROTECTED_RESOURCE = /^\/\.well-known\/oauth-protected-resource\/([a-z][a-z0-9-]*)\/mcp$/u;

// What Bun's server offers the fetch handler: the peer address of a request.
export type PeerAddress = { requestIP: (request: Request) => { address: string } | null };

const oauthError = (error: string) => Response.json({ error }, { status: 400 });

const methodNotAllowed = (allow: string) =>
  new Response('Method Not Allowed', { headers: { Allow: allow }, status: 405 });

// The media type of a Content-Type header, without parameters, in lowercase.
const mediaType = (header: string | null) => header?.split(';')[0]?.trim().toLowerCase();

// The request body as text, or undefined when it is over `limit` bytes.
const readLimitedText = async (request: Request, limit: number) => {
  if (Number(request.headers.get('content-length')) > limit) {
    return undefined;
  }
  if (request.body === null) {
    return '';
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream arrives one chunk at a time
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

// A registration's source: the address cloudflared reports, else the peer.
const sourceOf = (request: Request, server: PeerAddress | undefined) =>
  sourceKey(
    request.headers.get('cf-connecting-ip')?.trim() ??
      server?.requestIP(request)?.address ??
      'unknown',
  );

export const createOAuthEndpoints = ({
  config,
  log,
  now,
  store,
}: {
  config: Config;
  log: Log;
  now: () => number;
  store: Store;
}) => {
  const issuer = config.public.base_url;
  const authorizationServerMetadata = {
    authorization_endpoint: `${config.admin.base_url}/authorize`,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    issuer,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    token_endpoint: `${issuer}/oauth/token`,
    token_endpoint_auth_methods_supported: ['none'],
  };
  const perSource = createWindowLimit({
    limit: REGISTRATIONS_PER_SOURCE,
    now,
    windowMs: REGISTRATION_WINDOW_MS,
  });
  const overall = createWindowLimit({
    limit: REGISTRATIONS_OVERALL,
    now,
    windowMs: REGISTRATION_WINDOW_MS,
  });

  const register = async (request: Request, server: PeerAddress | undefined) => {
    if (mediaType(request.headers.get('content-type')) !== 'application/json') {
      return oauthError('invalid_client_metadata');
    }
    const text = await readLimitedText(request, BODY_LIMIT);
    if (text === undefined) {
      return oauthError('invalid_client_metadata');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return oauthError('invalid_client_metadata');
    }
    const metadata = parseClientMetadata(body);
    if (!metadata.ok) {
      return oauthError(metadata.error);
    }
    const source = sourceOf(request, server);
    const wait = Math.max(perSource.wait(source), overall.wait('all'));
    if (wait > 0) {
      return new Response('Too Many Requests', {
        headers: { 'Retry-After': String(Math.ceil(wait / 1000)) },
        status: 429,
      });
    }
    const client = store.registerClient(metadata);
    perSource.record(source);
    overall.record('all');
    log.info(
      `Registered client ${client.clientId.slice(0, 8)}${
        client.clientName === undefined ? '' : ` (${loggable(client.clientName)})`
      }.`,
    );
    return Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: client.clientIdIssuedAt,
        ...(client.clientName === undefined ? {} : { client_name: client.clientName }),
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: client.redirectUris,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      { status: 201 },
    );
  };

  // Whether `client_id` names a client: a registration, or a Client ID
  // Metadata Document's URL, which has no registration and is fetched only
  // at the Approval page.
  const isKnownClient = (clientId: string) =>
    isClientIdMetadataUrl(clientId) || store.findClient(clientId) !== undefined;

  const tokenResponse = (result: TokenResult, clientId: string, presented: string) => {
    if (result.ok) {
      return Response.json({
        access_token: result.tokens.accessToken,
        expires_in: result.tokens.expiresIn,
        refresh_token: result.tokens.refreshToken,
        token_type: 'Bearer',
      });
    }
    if ('revokedAuthorizationId' in result) {
      log.warn(
        `Revoked authorization ${result.revokedAuthorizationId.slice(0, 8)} of client ${loggable(
          clientLabel(clientId),
        )}: a used ${presented} was presented again.`,
      );
    }
    return oauthError(result.error);
  };

  const token = async (request: Request) => {
    if (mediaType(request.headers.get('content-type')) !== 'application/x-www-form-urlencoded') {
      return oauthError('invalid_request');
    }
    const text = await readLimitedText(request, BODY_LIMIT);
    if (text === undefined) {
      return oauthError('invalid_request');
    }
    const parameters = new URLSearchParams(text);
    const names = [...parameters.keys()];
    // RFC 6749 §3.2: a parameter must not be sent more than once.
    if (new Set(names).size !== names.length) {
      return oauthError('invalid_request');
    }
    // RFC 6749 §3.1: a parameter sent without a value counts as omitted.
    const parameter = (name: string) => parameters.get(name) || undefined;
    const grantType = parameter('grant_type');
    const clientId = parameter('client_id');
    const resource = parameter('resource');
    if (grantType === 'authorization_code') {
      const code = parameter('code');
      const codeVerifier = parameter('code_verifier');
      if (
        code === undefined ||
        clientId === undefined ||
        codeVerifier === undefined ||
        !isCodeVerifier(codeVerifier)
      ) {
        return oauthError('invalid_request');
      }
      if (!isKnownClient(clientId)) {
        return oauthError('invalid_client');
      }
      const result = store.exchangeAuthorizationCode({
        clientId,
        code,
        codeVerifier,
        redirectUri: parameter('redirect_uri'),
        resource,
      });
      return tokenResponse(result, clientId, 'authorization code');
    }
    if (grantType === 'refresh_token') {
      const refreshToken = parameter('refresh_token');
      if (refreshToken === undefined || clientId === undefined) {
        return oauthError('invalid_request');
      }
      if (!isKnownClient(clientId)) {
        return oauthError('invalid_client');
      }
      const result = store.refresh({ clientId, refreshToken, resource });
      return tokenResponse(result, clientId, 'refresh token');
    }
    return oauthError(grantType === undefined ? 'invalid_request' : 'unsupported_grant_type');
  };

  // Answers a request for one of these endpoints, or returns undefined when
  // its path is none of them.
  return async (
    request: Request,
    server: PeerAddress | undefined,
  ): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    const { method } = request;
    if (pathname === '/.well-known/oauth-authorization-server') {
      return method === 'GET'
        ? Response.json(authorizationServerMetadata)
        : methodNotAllowed('GET');
    }
    const service = PROTECTED_RESOURCE.exec(pathname)?.[1];
    if (service !== undefined && Object.hasOwn(config.services, service)) {
      return method === 'GET'
        ? Response.json({
            authorization_servers: [issuer],
            bearer_methods_supported: ['header'],
            resource: serviceResource(config, service),
          })
        : methodNotAllowed('GET');
    }
    if (pathname === '/oauth/register') {
      return method === 'POST' ? register(request, server) : methodNotAllowed('POST');
    }
    if (pathname === '/oauth/token') {
      return method === 'POST' ? token(request) : methodNotAllowed('POST');
    }
    return undefined;
  };
};
