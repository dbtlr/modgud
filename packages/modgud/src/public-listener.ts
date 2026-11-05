import {
  isInitializeRequest,
  isJsonContentType,
  readRequestBody,
} from '@modelcontextprotocol/server';

import { bearerToken, matchesTokenHash } from './bearer.ts';
import { childEnvironment } from './child-environment.ts';
import type { Config } from './config.ts';
import type { Log } from './log.ts';
import { Session } from './session.ts';
import type { SessionEndReason } from './session.ts';

// Every credential of Phase 1's harness counts as a credential of this one
// Grant (ADR-0001), so every Session the harness opens is bound to it.
const HARNESS_GRANT = 'harness';

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

export type PublicListener = {
  fetch: (request: Request) => Promise<Response>;
  // Ends every Session and stops every Child.
  close: () => Promise<void>;
  sessionCount: () => number;
};

// The Public listener's request handler (ADR-0003): `/<service>/mcp` for each
// configured Service, behind the harness's static bearer token.
export const createPublicListener = ({
  config,
  log,
  parentEnvironment,
}: {
  config: Config;
  log: Log;
  parentEnvironment: Readonly<Record<string, string | undefined>>;
}): PublicListener => {
  const sessions = new Map<string, Session>();
  // Sessions whose Child is starting or whose initialize is being answered.
  let opening = 0;
  const allowedOrigins = new Set(config.public.allowed_origins.map((url) => new URL(url).origin));

  const ended = (session: Session, reason: SessionEndReason) => {
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
    }
    if (reason !== 'not initialized') {
      log.info(`${session.service} session ${session.id.slice(0, 8)} ended: ${reason}.`);
    }
  };

  // The Grant the request's credential derives from, or undefined when it
  // carries no valid credential.
  const authenticate = (request: Request): string | undefined => {
    const token = bearerToken(request.headers.get('authorization'));
    return token !== undefined && matchesTokenHash(token, config.harness.bearer_token_sha256)
      ? HARNESS_GRANT
      : undefined;
  };

  const initialize = async (request: Request, serviceName: string, grant: string) => {
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
    if (sessions.size + opening >= config.public.max_sessions) {
      log.warn(`Refused a ${serviceName} session: ${String(config.public.max_sessions)} are open.`);
      return jsonRpcError(503, -32_000, 'Too many open sessions', { 'Retry-After': '30' });
    }
    const service = config.services[serviceName];
    if (service === undefined) {
      return notFound();
    }
    opening += 1;
    try {
      let session: Session;
      try {
        session = await Session.open({
          command: service,
          environment: childEnvironment({
            identity: undefined,
            parent: parentEnvironment,
            service,
          }),
          grant,
          log,
          onEnd: ended,
          service: serviceName,
        });
      } catch (error) {
        log.warn(`Could not start the ${serviceName} Child: ${String(error)}`);
        return jsonRpcError(502, -32_603, 'The Service could not be started');
      }
      sessions.set(session.id, session);
      const response = await session.handle(request, parsed);
      if (!session.initialized) {
        await session.end('not initialized');
      } else if (!session.ended) {
        log.info(`${serviceName} session ${session.id.slice(0, 8)} opened.`);
      }
      return response;
    } finally {
      opening -= 1;
    }
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
    const grant = authenticate(request);
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
    if (session === undefined || session.service !== serviceName || session.grant !== grant) {
      return sessionNotFound();
    }
    return session.handle(request);
  };

  return {
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.end('shutdown')));
    },
    fetch,
    sessionCount: () => sessions.size,
  };
};
