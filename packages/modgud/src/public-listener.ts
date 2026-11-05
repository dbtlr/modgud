import {
  isInitializeRequest,
  isJsonContentType,
  readRequestBody,
} from '@modelcontextprotocol/server';

import { bearerToken, matchesTokenHash } from './bearer.ts';
import { childEnvironment } from './child-environment.ts';
import type { Config, ServiceConfig } from './config.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import { INITIALIZE_TIMEOUT_MS, Session } from './session.ts';
import type { SessionEndHandler } from './session.ts';

// The Grant a request's credential derives from: the one Service it covers,
// and the Identity, if any, that its Children receive (ADR-0001).
export type Grant = { id: string; identity: string | undefined; service: string };

// Every credential of Phase 1's harness counts as a credential of this one
// Grant (ADR-0001), so every Session the harness opens is bound to it.
const HARNESS_GRANT_ID = 'harness';

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

// The MCP "session not found" answer. A Session bound to another Grant gets
// the same answer, so a Caller learns nothing about it (ADR-0002).
const sessionNotFound = () => jsonRpcError(404, -32_001, 'Session not found');

const shuttingDown = () => jsonRpcError(503, -32_000, 'Modgud is shutting down');

export type PublicListener = {
  fetch: (request: Request) => Promise<Response>;
  // Refuses new Sessions, then ends every Session, including any still
  // opening, and resolves once every Child has stopped, including those of
  // Sessions that were already ending.
  close: () => Promise<void>;
  sessionCount: () => number;
};

// The Public listener's request handler (ADR-0003): `/<service>/mcp` for each
// configured Service, behind the harness's static bearer token.
export const createPublicListener = ({
  config,
  initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
  log,
  parentEnvironment,
}: {
  config: Config;
  initializeTimeoutMs?: number;
  log: Log;
  parentEnvironment: Readonly<Record<string, string | undefined>>;
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

  // The Grant the request's credential derives from, or undefined when it
  // carries no valid credential for this Service.
  const authenticate = (request: Request, serviceName: string): Grant | undefined => {
    const token = bearerToken(request.headers.get('authorization'));
    const valid =
      token !== undefined &&
      matchesTokenHash(token, config.harness.bearer_token_sha256) &&
      config.harness.service === serviceName;
    return valid
      ? { id: HARNESS_GRANT_ID, identity: undefined, service: config.harness.service }
      : undefined;
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

  const initialize = async (request: Request, serviceName: string, grant: Grant) => {
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
    if (sessions.size + opening.size >= config.public.max_sessions) {
      log.warn(`Refused a ${serviceName} session: ${String(config.public.max_sessions)} are open.`);
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
      log.info(`${serviceName} session ${session.id.slice(0, 8)} opened.`);
    }
    return response;
  };

  const fetch = async (request: Request): Promise<Response> => {
    const serviceName = SERVICE_PATH.exec(new URL(request.url).pathname)?.[1];
    if (serviceName === undefined || !Object.hasOwn(config.services, serviceName)) {
      return notFound();
    }
    // A browser page on another site must not drive a Service (DNS rebinding).
    const origin = request.headers.get('origin');
    if (origin !== null && !allowedOrigins.has(origin)) {
      return jsonRpcError(403, -32_000, 'Forbidden: Origin not allowed');
    }
    const grant = authenticate(request, serviceName);
    if (grant === undefined) {
      return jsonRpcError(401, -32_001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId === null) {
      return request.method === 'POST'
        ? initialize(request, serviceName, grant)
        : jsonRpcError(400, -32_000, 'Bad Request: Mcp-Session-Id header is required');
    }
    const session = sessions.get(sessionId);
    if (session === undefined || session.service !== serviceName || session.grant !== grant.id) {
      return sessionNotFound();
    }
    return session.handle(request);
  };

  return {
    close: async () => {
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
