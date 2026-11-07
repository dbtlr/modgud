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
import { answerUnexpectedError } from './http.ts';
import type { PeerAddress } from './http.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import { createOAuthEndpoints } from './oauth-endpoints.ts';
import { INITIALIZE_TIMEOUT_MS, Session } from './session.ts';
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

// How often Modgud checks that each Session's authorization is still active,
// so a revoked or expired one ends its Sessions within 10 seconds, even when
// `modgud revoke` changed the store from another process.
export const AUTHORIZATION_SWEEP_MS = 2000;

// How often Modgud deletes expired rows from the store.
export const STORE_CLEANUP_MS = 60 * 60_000;

// The longest Origin or protocol version a log line carries.
const ORIGIN_LOG_LIMIT = 200;
const PROTOCOL_LOG_LIMIT = 64;

const STATIC_TOKEN_CALLER = 'the static bearer token';

// A caller-controlled string as a log line may carry it: its first `limit`
// code points, with control characters escaped.
// oxlint-disable-next-line typescript/no-misused-spread -- code points, as loggable counts them
const logged = (text: string, limit: number) => loggable([...text].slice(0, limit).join(''));

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

export type PublicListener = {
  // Bun's server passes itself as the second argument, which gives the peer
  // address that registration limits count by.
  fetch: (request: Request, server?: PeerAddress) => Promise<Response>;
  // Stops the store timers, refuses new Sessions, then ends every Session,
  // including any still opening, and resolves once every Child has stopped,
  // including those of Sessions that were already ending. It leaves the
  // store open for its owner to close.
  close: () => Promise<void>;
  sessionCount: () => number;
};

// The Public listener's request handler (ADR-0003): the OAuth metadata,
// registration, and token endpoints, and `/<service>/mcp` for each configured
// Service, behind the harness's static bearer token or an OAuth access token.
export const createPublicListener = ({
  authorizationSweepMs = AUTHORIZATION_SWEEP_MS,
  config,
  initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
  log,
  now = Date.now,
  parentEnvironment,
  storeCleanupMs = STORE_CLEANUP_MS,
  store,
}: {
  authorizationSweepMs?: number;
  config: Config;
  initializeTimeoutMs?: number;
  log: Log;
  // Milliseconds since the epoch, for the registration limits.
  now?: () => number;
  parentEnvironment: Readonly<Record<string, string | undefined>>;
  storeCleanupMs?: number;
  store: Store;
}): PublicListener => {
  const sessions = new Map<string, Session>();
  // Each Session whose Child is starting, settled once it is in `sessions`
  // or has ended.
  const opening = new Set<Promise<Session | undefined>>();
  // For each Session that has ended, the promise that settles once its Child
  // has stopped, until it does.
  const stopping = new Set<Promise<void>>();
  let closing = false;
  const allowedOrigins = new Set(config.public.allowed_origins.map((url) => new URL(url).origin));

  const untilStopped = async (stopped: Promise<void>) => {
    stopping.add(stopped);
    await stopped;
    stopping.delete(stopped);
  };

  const ended: SessionEndHandler = (session, reason, stopped) => {
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
    }
    void untilStopped(stopped);
    if (reason !== 'not initialized') {
      log.info(`${session.service} session ${session.id.slice(0, 8)} ended: ${reason}.`);
    }
  };

  const oauthEndpoints = createOAuthEndpoints({ config, log, now, store });

  // Ends every Session whose authorization was revoked, expired, or is no
  // longer for the harness Service.
  const sweepAuthorizations = () => {
    for (const session of sessions.values()) {
      const authorizationId = authorizationOf(session.grant);
      if (authorizationId !== undefined && !store.isAuthorizationActive(authorizationId)) {
        void session.end('authorization ended');
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
    every(authorizationSweepMs, sweepAuthorizations, "check the Sessions' authorizations"),
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

  // Starts a Session's Child and adds the Session to `sessions`, unless the
  // listener began closing meanwhile: then it ends the Session at once.
  const openSession = async (serviceName: string, service: ServiceConfig, grant: Grant) => {
    const session = await Session.open({
      command: service,
      environment: childEnvironment({
        identity: grant.identity,
        parent: parentEnvironment,
        service,
      }),
      grant: grant.id,
      initializeTimeoutMs,
      log,
      onEnd: ended,
      service: serviceName,
    });
    if (closing) {
      await session.end('shutdown');
      return undefined;
    }
    sessions.set(session.id, session);
    return session;
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
    if (sessions.size + opening.size >= config.public.max_sessions_per_grant) {
      log.warn(
        `Refused a ${serviceName} session: ${String(config.public.max_sessions_per_grant)} are open.`,
      );
      return jsonRpcError(503, -32_000, 'Too many open sessions', { 'Retry-After': '30' });
    }
    const service = config.services[serviceName];
    if (service === undefined) {
      return notFound();
    }
    const opened = openSession(serviceName, service, grant);
    opening.add(opened);
    let session: Session | undefined;
    try {
      session = await opened;
    } catch (error) {
      log.warn(`Could not start the ${serviceName} Child: ${loggable(String(error))}`);
      return jsonRpcError(502, -32_603, 'The Service could not be started');
    } finally {
      opening.delete(opened);
    }
    if (session === undefined) {
      return shuttingDown();
    }
    const response = await session.handle(request, parsed);
    if (!session.initialized) {
      await session.end('not initialized');
    } else if (!session.ended) {
      const origin = request.headers.get('origin');
      log.info(
        `${serviceName} session ${session.id.slice(0, 8)} opened for ${caller}, Origin ${
          origin === null ? 'none' : logged(origin, ORIGIN_LOG_LIMIT)
        }, protocol ${logged(parsed.params.protocolVersion, PROTOCOL_LOG_LIMIT)}.`,
      );
    }
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
        `Refused a ${serviceName} request from ${authentication.caller}: Origin ${logged(
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
      for (const session of sessions.values()) {
        void session.end('shutdown');
      }
      // Each Session just ended is now in `stopping`; each one still opening
      // is ended as soon as it opens.
      await Promise.allSettled([...opening, ...stopping]);
    },
    fetch,
    sessionCount: () => sessions.size,
  };
};
