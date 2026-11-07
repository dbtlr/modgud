import {
  isInitializeRequest,
  isJsonContentType,
  readRequestBody,
} from '@modelcontextprotocol/server';

import { bearerToken, matchesTokenHash } from './bearer.ts';
import { childEnvironment } from './child-environment.ts';
import { clientLabel } from './client-metadata.ts';
import { serviceResource } from './config.ts';
import type { Config, ServiceConfig } from './config.ts';
import { CHILD_LIMITS, GrantChild } from './grant-child.ts';
import type { ChildLimits } from './grant-child.ts';
import { answerUnexpectedError } from './http.ts';
import type { PeerAddress } from './http.ts';
import { excerpt, loggable } from './log.ts';
import type { Log } from './log.ts';
import { createOAuthEndpoints } from './oauth-endpoints.ts';
import { initializeAnswer } from './protocol.ts';
import { Session } from './session.ts';
import type { SessionEndHandler } from './session.ts';
import type { Store } from './store.ts';

// The Grant a request's credential derives from: the one Service it covers,
// and the Identity, if any, that its Children receive (ADR-0001). Its id names
// the credential source a Session is bound to: the harness's static bearer
// token, or one OAuth authorization (docs/oauth.md, "Service endpoints").
export type Grant = { id: string; identity: string | undefined; service: string };

const STATIC_TOKEN_GRANT_ID = 'static-token';
const AUTHORIZATION_GRANT_PREFIX = 'authorization:';

// The OAuth authorization a Grant id names, or undefined for the static token.
const authorizationOf = (grantId: string) =>
  grantId.startsWith(AUTHORIZATION_GRANT_PREFIX)
    ? grantId.slice(AUTHORIZATION_GRANT_PREFIX.length)
    : undefined;

// A Grant as log lines name it: the static token, or a short prefix of the
// authorization's id.
const grantLabel = (grantId: string) => {
  const authorizationId = authorizationOf(grantId);
  return authorizationId === undefined
    ? STATIC_TOKEN_GRANT_ID
    : `authorization ${authorizationId.slice(0, 8)}`;
};

// How often Modgud checks that each Grant's authorization is still active,
// so a revoked or expired one ends its Sessions and stops its Child within
// 10 seconds, even when `modgud revoke` changed the store from another
// process.
export const AUTHORIZATION_SWEEP_MS = 2000;

// How often Modgud deletes expired rows from the store.
export const STORE_CLEANUP_MS = 60 * 60_000;

// The longest Origin or protocol version a log line carries.
const ORIGIN_LOG_LIMIT = 200;
const PROTOCOL_LOG_LIMIT = 64;

const STATIC_TOKEN_CALLER = 'the static bearer token';

// A Grant's shared Child, as a map key: one per Service and Grant.
const childKey = (serviceName: string, grantId: string) => `${serviceName}\n${grantId}`;

const SERVICE_PATH = /^\/([a-z][a-z0-9-]*)\/mcp$/u;

const jsonRpcError = (
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
) =>
  Response.json(
    { error: { code, message }, id: null, jsonrpc: '2.0' },
    { headers: headers ?? {}, status },
  );

const notFound = () => new Response('Not Found', { status: 404 });

// Every response of the Public listener carries `Cache-Control: no-store`
// (docs/oauth.md, "Public listener endpoints").
const noStore = (response: Response) => {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

// The MCP "session not found" answer. A Session bound to another Grant gets
// the same answer, so a Caller learns nothing about it (ADR-0002).
const sessionNotFound = () => jsonRpcError(404, -32_001, 'Session not found');

const shuttingDown = () => jsonRpcError(503, -32_000, 'Modgud is shutting down');

const notStarted = () => jsonRpcError(502, -32_603, 'The Service could not be started');

export type PublicListener = {
  // Bun's server passes itself as the second argument, which gives the peer
  // address that registration limits count by.
  fetch: (request: Request, server?: PeerAddress) => Promise<Response>;
  // Stops the store timers, refuses new Sessions, then ends every Session,
  // including any still opening, stops every Child, including any still
  // starting, and resolves once every Child has exited, including those
  // already stopping. It leaves the store open for its owner to close.
  close: () => Promise<void>;
  sessionCount: () => number;
};

// The Public listener's request handler (ADR-0003): the OAuth metadata,
// registration, and token endpoints, and `/<service>/mcp` for each configured
// Service, behind the harness's static bearer token or an OAuth access token.
export const createPublicListener = ({
  authorizationSweepMs = AUTHORIZATION_SWEEP_MS,
  childLimits = {},
  config,
  log,
  now = Date.now,
  parentEnvironment,
  storeCleanupMs = STORE_CLEANUP_MS,
  store,
}: {
  authorizationSweepMs?: number;
  // Shorter bounds on each Grant's Child, for tests.
  childLimits?: Partial<ChildLimits>;
  config: Config;
  log: Log;
  // Milliseconds since the epoch, for the registration limits.
  now?: () => number;
  parentEnvironment: Readonly<Record<string, string | undefined>>;
  storeCleanupMs?: number;
  store: Store;
}): PublicListener => {
  const limits: ChildLimits = { ...CHILD_LIMITS, ...childLimits };
  // Every open Session, by id.
  const sessions = new Map<string, Session>();
  // Each Grant's shared Child, by Service and Grant id, from the Grant's
  // first Session until the Grant ends or Modgud shuts down.
  const children = new Map<string, GrantChild>();
  // Children that ended for good, until they have exited.
  const ending = new Set<Promise<void>>();
  let closing = false;
  const allowedOrigins = new Set(config.public.allowed_origins.map((url) => new URL(url).origin));
  const sessionIdleMs = config.public.session_idle_timeout_minutes * 60_000;

  // The Grant's shared Child, created on first use. It starts no process
  // until a request needs one.
  const childFor = (serviceName: string, service: ServiceConfig, grant: Grant) => {
    const key = childKey(serviceName, grant.id);
    let child = children.get(key);
    if (child === undefined) {
      child = new GrantChild({
        command: service,
        environment: () =>
          childEnvironment({ identity: grant.identity, parent: parentEnvironment, service }),
        grant: grant.id,
        grantLabel: grantLabel(grant.id),
        limits,
        log,
        service: serviceName,
      });
      children.set(key, child);
    }
    return child;
  };

  const untilExited = async (exited: Promise<void>) => {
    ending.add(exited);
    await exited;
    ending.delete(exited);
  };

  // Ends a Grant's Sessions and stops its Child for good.
  const endChild = (child: GrantChild, kind: 'grant ended' | 'shutdown') => {
    children.delete(childKey(child.service, child.grant));
    void untilExited(child.end(kind));
  };

  const ended: SessionEndHandler = (session, reason) => {
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
    }
    if (reason !== 'not initialized') {
      log.info(`${session.service} session ${session.id.slice(0, 8)} ended: ${reason}.`);
    }
  };

  const oauthEndpoints = createOAuthEndpoints({ config, log, now, store });

  // Ends the Sessions and stops the Child of every Grant whose authorization
  // was revoked, expired, or is no longer for the harness Service, whether
  // or not it still has Sessions.
  const sweepAuthorizations = () => {
    for (const child of children.values()) {
      const authorizationId = authorizationOf(child.grant);
      if (authorizationId !== undefined && !store.isAuthorizationActive(authorizationId)) {
        endChild(child, 'grant ended');
      }
    }
  };

  // Runs a store task on a timer, logging a failure, such as a store another
  // process holds busy, instead of letting it escape.
  const every = (intervalMs: number, task: () => void, name: string) =>
    setInterval(() => {
      try {
        task();
      } catch (error) {
        log.warn(`Could not ${name}: ${loggable(String(error))}`);
      }
    }, intervalMs);
  const timers = [
    every(authorizationSweepMs, sweepAuthorizations, "check the Grants' authorizations"),
    every(storeCleanupMs, () => store.removeExpired(), 'delete expired rows from the store'),
  ];

  // The Grant the request's credential derives from: `valid` with it and the
  // caller as a log line names it, or `missing` without a bearer token, or
  // `invalid` when the bearer token is not valid for this Service.
  const authenticate = (
    request: Request,
    serviceName: string,
  ): { result: 'valid'; grant: Grant; caller: string } | { result: 'invalid' | 'missing' } => {
    const token = bearerToken(request.headers.get('authorization'));
    if (token === undefined) {
      return { result: 'missing' };
    }
    if (matchesTokenHash(token, config.harness.bearer_token_sha256)) {
      return config.harness.service === serviceName
        ? {
            caller: STATIC_TOKEN_CALLER,
            grant: { id: STATIC_TOKEN_GRANT_ID, identity: undefined, service: serviceName },
            result: 'valid',
          }
        : { result: 'invalid' };
    }
    const access = store.verifyAccessToken(token);
    if (access === undefined || access.resource !== serviceResource(config, serviceName)) {
      return { result: 'invalid' };
    }
    return {
      caller: `client ${loggable(clientLabel(access.clientId))} authorization ${access.authorizationId.slice(0, 8)}`,
      grant: {
        id: `${AUTHORIZATION_GRANT_PREFIX}${access.authorizationId}`,
        identity: undefined,
        service: serviceName,
      },
      result: 'valid',
    };
  };

  // The 401 that points a Caller at the Service's protected-resource metadata.
  const unauthorized = (serviceName: string, invalidToken: boolean) => {
    const metadata = `${config.public.base_url}/.well-known/oauth-protected-resource/${serviceName}/mcp`;
    return jsonRpcError(401, -32_001, 'Unauthorized', {
      'WWW-Authenticate': `Bearer resource_metadata="${metadata}"${
        invalidToken ? ', error="invalid_token"' : ''
      }`,
    });
  };

  const initialize = async (
    request: Request,
    serviceName: string,
    { caller, grant }: { caller: string; grant: Grant },
  ) => {
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return jsonRpcError(
        415,
        -32_000,
        'Unsupported Media Type: Content-Type must be application/json',
      );
    }
    const body = await readRequestBody(request);
    if (body.tooLarge) {
      return jsonRpcError(413, -32_000, 'Payload Too Large');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return jsonRpcError(400, -32_700, 'Parse error');
    }
    // Anything but an initialize request needs a Session. This is the answer a
    // 2025-era server gives, so a Caller probing for a later protocol revision
    // falls back to initialize.
    if (!isInitializeRequest(parsed)) {
      return jsonRpcError(400, -32_000, 'Bad Request: Mcp-Session-Id header is required');
    }
    if (closing) {
      return shuttingDown();
    }
    const service = config.services[serviceName];
    if (service === undefined) {
      return notFound();
    }
    const child = childFor(serviceName, service, grant);
    const session = new Session({
      child,
      grant: grant.id,
      idleMs: sessionIdleMs,
      log,
      onEnd: ended,
      service: serviceName,
    });
    if (!child.admit(session, config.public.max_sessions_per_grant)) {
      log.warn(
        `Refused a ${serviceName} session for ${caller}: ${String(config.public.max_sessions_per_grant)} are opening.`,
      );
      return jsonRpcError(503, -32_000, 'Too many sessions are opening', { 'Retry-After': '30' });
    }
    const readiness = await child.ready();
    if (readiness.kind !== 'ready' || session.ended) {
      session.end('not initialized');
      if (readiness.kind === 'grant ended') {
        return unauthorized(serviceName, true);
      }
      return readiness.kind === 'failed' ? notStarted() : shuttingDown();
    }
    const response = await session.open(
      request,
      parsed,
      initializeAnswer(parsed.params.protocolVersion, readiness.result),
    );
    // A Session evicted while its initialize was answered never enters the map.
    if (session.given === undefined || session.ended) {
      session.end('not initialized');
      return response;
    }
    sessions.set(session.id, session);
    const origin = request.headers.get('origin');
    log.info(
      `${serviceName} session ${session.id.slice(0, 8)} opened for ${caller}, Origin ${
        origin === null ? 'none' : excerpt(origin, ORIGIN_LOG_LIMIT)
      }, protocol ${excerpt(parsed.params.protocolVersion, PROTOCOL_LOG_LIMIT)}.`,
    );
    return response;
  };

  // Warns of a request refused for its Origin, only when its credential is
  // valid, so an anonymous flood cannot fill the log. The 403 stands even when
  // the store cannot be read.
  const warnOfRefusedOrigin = (request: Request, serviceName: string, origin: string) => {
    let authentication: ReturnType<typeof authenticate>;
    try {
      authentication = authenticate(request, serviceName);
    } catch {
      return;
    }
    if (authentication.result === 'valid') {
      log.warn(
        `Refused a ${serviceName} request from ${authentication.caller}: Origin ${excerpt(
          origin,
          ORIGIN_LOG_LIMIT,
        )} is not allowed.`,
      );
    }
  };

  const serviceRequest = async (request: Request): Promise<Response> => {
    const serviceName = SERVICE_PATH.exec(new URL(request.url).pathname)?.[1];
    if (serviceName === undefined || !Object.hasOwn(config.services, serviceName)) {
      return notFound();
    }
    // A browser page on another site must not drive a Service (DNS rebinding).
    const origin = request.headers.get('origin');
    if (origin !== null && !allowedOrigins.has(origin)) {
      warnOfRefusedOrigin(request, serviceName, origin);
      return jsonRpcError(403, -32_000, 'Forbidden: Origin not allowed');
    }
    const authentication = authenticate(request, serviceName);
    if (authentication.result !== 'valid') {
      return unauthorized(serviceName, authentication.result === 'invalid');
    }
    const { grant } = authentication;
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId === null) {
      return request.method === 'POST'
        ? initialize(request, serviceName, authentication)
        : jsonRpcError(400, -32_000, 'Bad Request: Mcp-Session-Id header is required');
    }
    const session = sessions.get(sessionId);
    if (session === undefined || session.service !== serviceName || session.grant !== grant.id) {
      return sessionNotFound();
    }
    return session.handle(request);
  };

  // A request that fails unexpectedly gets a plain HTTP 500, never a page
  // with the error's detail.
  const fetch = async (request: Request, server?: PeerAddress): Promise<Response> => {
    try {
      return noStore((await oauthEndpoints(request, server)) ?? (await serviceRequest(request)));
    } catch (error) {
      return answerUnexpectedError(log, request, error);
    }
  };

  return {
    close: async () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      closing = true;
      for (const child of children.values()) {
        endChild(child, 'shutdown');
      }
      await Promise.allSettled(ending);
    },
    fetch,
    sessionCount: () => sessions.size,
  };
};
