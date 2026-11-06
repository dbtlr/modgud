import { renderApprovalPage, renderErrorPage, hostOf, pageHeaders } from './admin-pages.ts';
import type { ErrorPage } from './admin-pages.ts';
import { matchesTokenHash, sha256Hex } from './bearer.ts';
import { clientLabel, isClientIdMetadataUrl, matchRedirectUri } from './client-metadata.ts';
import { serviceResource } from './config.ts';
import type { Config } from './config.ts';
import { answerUnexpectedError, mediaType, readLimitedText } from './http.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import { createMetadataDocumentFetcher } from './metadata-document.ts';
import type { FetchMetadataDocument } from './metadata-document.ts';
import { isCodeChallenge } from './pkce.ts';
import { createWindowLimit } from './rate-limit.ts';
import { randomIdentifier } from './secrets.ts';
import type { Store } from './store.ts';

// The Admin listener (ADR-0003; docs/oauth.md, "Admin listener endpoints"):
// the OAuth authorization endpoint, where a person on the tailnet sees which
// client asks for a connection and approves it with a Pairing code.

const MINUTE = 60_000;

const QUERY_LIMIT = 8 * 1024;
const FORM_LIMIT = 4 * 1024;
const STATE_LIMIT = 1024;
const PENDING_LIFETIME = 10 * MINUTE;
const PENDING_CAPACITY = 50;
const FAILURES_PER_REQUEST = 5;
const FAILED_CODES_WINDOW = 10 * MINUTE;
const FAILED_CODES_LIMIT = 20;

const PENDING_COOKIE_PREFIX = '__Host-modgud-pending-';

// An authorization request waiting for the person to approve or deny it.
type PendingRequest = {
  id: string;
  // The random value of its cookie.
  cookie: string;
  createdAt: number;
  failures: number;
  clientId: string;
  clientName: string | undefined;
  metadataUrl: string | undefined;
  redirectUri: string;
  requestedRedirectUri: string | null;
  codeChallenge: string;
  state: string | undefined;
};

// A client as an authorization request resolves it.
type ResolvedClient = {
  clientName: string | undefined;
  metadataUrl: string | undefined;
  redirectUris: string[];
};

type AuthorizationError =
  | 'invalid_request'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unsupported_response_type';

const AUTHORIZATION_ERRORS: Record<AuthorizationError, string> = {
  invalid_request: 'The client sent an authorization request that is missing or malformed.',
  invalid_scope: 'The client asked for a scope. Modgud has no scopes.',
  invalid_target: 'The client asked for a Service this Modgud does not offer.',
  unsupported_response_type:
    'The client asked for a response type other than an authorization code.',
};

export type AdminListener = {
  fetch: (request: Request) => Promise<Response>;
  // Forgets every pending request.
  close: () => void;
};

const pendingCookieName = (id: string) => `${PENDING_COOKIE_PREFIX}${id.slice(0, 8)}`;

// The cookie that binds the browser to a pending request (docs/oauth.md,
// "Approval page"), or the header that clears it.
const pendingCookie = (pending: Pick<PendingRequest, 'cookie' | 'id'>, maxAge: number) =>
  `${pendingCookieName(pending.id)}=${maxAge === 0 ? '' : pending.cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(maxAge)}`;

const cookieValue = (request: Request, name: string) => {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const [key = '', ...rest] = pair.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return undefined;
};

// Compares SHA-256 digests, which always have the same length, so any two
// strings compare in constant time without throwing.
const equalSecrets = (presented: string, expected: string) =>
  matchesTokenHash(presented, sha256Hex(expected));

// A top-level browser navigation: `Sec-Fetch-Mode: navigate` with
// `Sec-Fetch-Dest: document`, or no `Sec-Fetch-` header at all, as browsers
// older than Safari 16.4 send.
const isTopLevelNavigation = (request: Request) => {
  const fetchMetadata = [...request.headers.keys()].some((name) => name.startsWith('sec-fetch-'));
  return (
    !fetchMetadata ||
    (request.headers.get('sec-fetch-mode') === 'navigate' &&
      request.headers.get('sec-fetch-dest') === 'document')
  );
};

// The redirect URI with response parameters appended, keeping its own query
// exactly as written.
const redirectWith = (redirectUri: string, parameters: Record<string, string | undefined>) => {
  const query = new URLSearchParams(
    Object.entries(parameters).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : [[name, value]],
    ),
  ).toString();
  if (!redirectUri.includes('?')) {
    return `${redirectUri}?${query}`;
  }
  return redirectUri.endsWith('?') || redirectUri.endsWith('&')
    ? `${redirectUri}${query}`
    : `${redirectUri}&${query}`;
};

const misdirected = () =>
  new Response('Misdirected Request', {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    status: 421,
  });

const notFound = () =>
  new Response('Not Found', {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    status: 404,
  });

const forbidden = () =>
  new Response('Forbidden', {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    status: 403,
  });

const errorPage = (status: number, page: ErrorPage, redirectUri?: string, cookie?: string) => {
  const headers = pageHeaders(redirectUri);
  if (cookie !== undefined) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(renderErrorPage(page), { headers, status });
};

export const createAdminListener = ({
  config,
  fetchMetadataDocument,
  log,
  now = Date.now,
  store,
}: {
  config: Config;
  // Defaults to the safe fetcher; tests inject one.
  fetchMetadataDocument?: FetchMetadataDocument;
  log: Log;
  // Milliseconds since the epoch.
  now?: () => number;
  store: Store;
}): AdminListener => {
  const adminHost = new URL(config.admin.base_url).host;
  const issuer = config.public.base_url;
  const serviceName = config.harness.service;
  const resource = serviceResource(config, serviceName);
  const fetchDocument = fetchMetadataDocument ?? createMetadataDocumentFetcher({ log, now });
  const failedCodes = createWindowLimit({
    limit: FAILED_CODES_LIMIT,
    now,
    windowMs: FAILED_CODES_WINDOW,
  });

  // Pending requests by identifier, oldest first.
  const pending = new Map<string, PendingRequest>();

  const removeExpired = () => {
    for (const [id, request] of pending) {
      if (now() < request.createdAt + PENDING_LIFETIME) {
        break;
      }
      pending.delete(id);
    }
  };

  const findPending = (id: string) => {
    removeExpired();
    return pending.get(id);
  };

  const addPending = (
    request: Omit<PendingRequest, 'cookie' | 'createdAt' | 'failures' | 'id'>,
  ) => {
    removeExpired();
    while (pending.size >= PENDING_CAPACITY) {
      const [oldest] = pending.keys();
      if (oldest === undefined) {
        break;
      }
      pending.delete(oldest);
    }
    const created: PendingRequest = {
      ...request,
      cookie: randomIdentifier(),
      createdAt: now(),
      failures: 0,
      id: randomIdentifier(),
    };
    pending.set(created.id, created);
    return created;
  };

  const approvalPage = (request: PendingRequest, status: number, error?: string) => {
    const headers = pageHeaders(request.redirectUri);
    if (status === 200) {
      headers.append('Set-Cookie', pendingCookie(request, PENDING_LIFETIME / 1000));
    }
    return new Response(
      renderApprovalPage({
        clientName: request.clientName,
        metadataUrl: request.metadataUrl,
        pendingId: request.id,
        redirectUri: request.redirectUri,
        resource,
        serviceName,
        ...(error === undefined ? {} : { error }),
      }),
      { headers, status },
    );
  };

  // Step 1: the client, from its registration or its metadata document.
  const resolveClient = async (
    clientId: string,
  ): Promise<ResolvedClient | 'unavailable' | 'unknown'> => {
    if (isClientIdMetadataUrl(clientId)) {
      const document = await fetchDocument(clientId);
      return document === undefined
        ? 'unavailable'
        : {
            clientName: document.clientName,
            metadataUrl: clientId,
            redirectUris: document.redirectUris,
          };
    }
    const client = store.findClient(clientId);
    return client === undefined
      ? 'unknown'
      : {
          clientName: client.clientName,
          metadataUrl: undefined,
          redirectUris: client.redirectUris,
        };
  };

  // Step 2: the rest of the request.
  const checkRequest = (
    parameter: (name: string) => string | undefined,
  ): AuthorizationError | undefined => {
    const responseType = parameter('response_type');
    if (responseType === undefined) {
      return 'invalid_request';
    }
    if (responseType !== 'code') {
      return 'unsupported_response_type';
    }
    const challenge = parameter('code_challenge');
    if (
      challenge === undefined ||
      !isCodeChallenge(challenge) ||
      parameter('code_challenge_method') !== 'S256' ||
      (parameter('state')?.length ?? 0) > STATE_LIMIT
    ) {
      return 'invalid_request';
    }
    if (parameter('scope') !== undefined) {
      return 'invalid_scope';
    }
    const requested = parameter('resource');
    if (requested !== undefined && requested !== resource) {
      return 'invalid_target';
    }
    return undefined;
  };

  const authorizeGet = async (request: Request, url: URL) => {
    if (url.search.length - 1 > QUERY_LIMIT) {
      return errorPage(414, {
        message: 'The authorization request is too long. Start again from the client.',
        title: 'This request cannot be approved',
      });
    }
    if (!isTopLevelNavigation(request)) {
      return errorPage(400, {
        message:
          'Modgud shows the Approval page only when the browser opens it directly, as a chat client sends you here.',
        title: 'Open this page from the client',
      });
    }
    const parameters = url.searchParams;
    const names = [...parameters.keys()];
    if (new Set(names).size !== names.length) {
      return errorPage(400, {
        message: 'The authorization request repeats a parameter. Start again from the client.',
        title: 'This request cannot be approved',
      });
    }
    // RFC 6749 §3.1: a parameter sent without a value counts as omitted.
    const parameter = (name: string) => parameters.get(name) || undefined;
    const clientId = parameter('client_id');
    if (clientId === undefined) {
      return errorPage(400, {
        message: 'The authorization request does not name a client. Start again from the client.',
        title: 'This request cannot be approved',
      });
    }
    const client = await resolveClient(clientId);
    if (client === 'unknown') {
      return errorPage(400, {
        message:
          'Modgud does not know this client, or forgot it because it was never approved. Remove the connector from the client and add it again.',
        title: 'Unknown client',
      });
    }
    if (client === 'unavailable') {
      return errorPage(502, {
        message: "Modgud could not load this client's details. Try again later.",
        title: 'This request cannot be approved',
      });
    }
    const requestedRedirectUri = parameter('redirect_uri');
    const redirectUri = matchRedirectUri(client.redirectUris, requestedRedirectUri);
    if (redirectUri === undefined) {
      return errorPage(400, {
        message:
          requestedRedirectUri === undefined
            ? 'The authorization request does not say where to send its answer.'
            : 'The authorization request asks to send its answer to an address the client did not register.',
        title: 'This request cannot be approved',
      });
    }
    const state = parameter('state');
    const error = checkRequest(parameter);
    if (error !== undefined) {
      const host = hostOf(redirectUri);
      // A state over the limit is the error itself, so the link leaves it out.
      const returnedState = (state?.length ?? 0) > STATE_LIMIT ? undefined : state;
      return errorPage(
        400,
        {
          message: `${AUTHORIZATION_ERRORS[error]} The request came from a client that answers at ${host}.`,
          returnTo: {
            host,
            href: redirectWith(redirectUri, { error, iss: issuer, state: returnedState }),
          },
          title: 'This request cannot be approved',
        },
        redirectUri,
      );
    }
    const created = addPending({
      clientId,
      clientName: client.clientName,
      codeChallenge: parameter('code_challenge') ?? '',
      metadataUrl: client.metadataUrl,
      redirectUri,
      requestedRedirectUri: requestedRedirectUri ?? null,
      state,
    });
    return approvalPage(created, 200);
  };

  // Ends a pending request and sends the browser to its redirect URI.
  const finish = (request: PendingRequest, parameters: Record<string, string | undefined>) => {
    pending.delete(request.id);
    const headers = pageHeaders(request.redirectUri);
    headers.set(
      'Location',
      redirectWith(request.redirectUri, { ...parameters, iss: issuer, state: request.state }),
    );
    headers.append('Set-Cookie', pendingCookie(request, 0));
    return new Response(null, { headers, status: 303 });
  };

  const approve = (request: PendingRequest, pairingCode: string) => {
    const label = loggable(clientLabel(request.clientId));
    if (failedCodes.wait('all') > 0) {
      log.warn(
        `Refused a Pairing code for client ${label}: ${String(FAILED_CODES_LIMIT)} wrong codes in the last 10 minutes.`,
      );
      return approvalPage(
        request,
        429,
        'Too many wrong Pairing codes were entered recently. Wait a few minutes, then try again.',
      );
    }
    if (request.metadataUrl === undefined && store.findClient(request.clientId) === undefined) {
      pending.delete(request.id);
      return errorPage(
        400,
        {
          message:
            'Modgud no longer knows this client. Remove the connector from the client and add it again.',
          title: 'Unknown client',
        },
        undefined,
        pendingCookie(request, 0),
      );
    }
    const approved = store.approve({
      clientId: request.clientId,
      codeChallenge: request.codeChallenge,
      pairingCode,
      redirectUri: request.redirectUri,
      requestedRedirectUri: request.requestedRedirectUri,
    });
    if (approved === undefined) {
      request.failures += 1;
      failedCodes.record('all');
      log.warn(
        `A wrong Pairing code was entered for client ${label} (${String(request.failures)} of ${String(FAILURES_PER_REQUEST)}).`,
      );
      if (request.failures >= FAILURES_PER_REQUEST) {
        pending.delete(request.id);
        log.warn(
          `Ended the approval request of client ${label} after ${String(FAILURES_PER_REQUEST)} wrong Pairing codes.`,
        );
        return errorPage(
          400,
          {
            message:
              'Too many wrong Pairing codes were entered for this request. Start again from the client.',
            title: 'This request has ended',
          },
          undefined,
          pendingCookie(request, 0),
        );
      }
      return approvalPage(
        request,
        400,
        'That Pairing code is wrong, expired, or already used. Check it, or run modgud pair for a new one.',
      );
    }
    log.info(
      `Approved client ${label}${
        request.clientName === undefined ? '' : ` (${loggable(request.clientName)})`
      } as authorization ${approved.authorizationId.slice(0, 8)}.`,
    );
    return finish(request, { code: approved.code });
  };

  const authorizePost = async (request: Request) => {
    if (request.headers.get('origin') !== config.admin.base_url) {
      return forbidden();
    }
    const text =
      mediaType(request.headers.get('content-type')) === 'application/x-www-form-urlencoded'
        ? await readLimitedText(request, FORM_LIMIT)
        : undefined;
    if (text === undefined) {
      return errorPage(400, {
        message: 'The form could not be read. Start again from the client.',
        title: 'This request cannot be approved',
      });
    }
    const form = new URLSearchParams(text);
    const pendingRequest = findPending(form.get('request') ?? '');
    if (pendingRequest === undefined) {
      return errorPage(400, {
        message: 'This approval request has expired or already ended. Start again from the client.',
        title: 'This request has ended',
      });
    }
    const cookie = cookieValue(request, pendingCookieName(pendingRequest.id));
    if (cookie === undefined || !equalSecrets(cookie, pendingRequest.cookie)) {
      return forbidden();
    }
    const action = form.get('action');
    if (action === 'deny') {
      log.info(`Denied client ${loggable(clientLabel(pendingRequest.clientId))}.`);
      return finish(pendingRequest, { error: 'access_denied' });
    }
    if (action === 'approve') {
      return approve(pendingRequest, form.get('pairing_code') ?? '');
    }
    return approvalPage(pendingRequest, 400, 'Choose Approve or Deny.');
  };

  const route = async (request: Request) => {
    if (request.headers.get('host') !== adminHost) {
      return misdirected();
    }
    const url = new URL(request.url);
    if (url.pathname !== '/authorize') {
      return notFound();
    }
    if (request.method === 'GET') {
      return authorizeGet(request, url);
    }
    if (request.method === 'POST') {
      return authorizePost(request);
    }
    return new Response('Method Not Allowed', {
      headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' },
      status: 405,
    });
  };

  // A request that fails unexpectedly gets a plain HTTP 500, never a page
  // with the error's detail.
  const fetch = async (request: Request) => {
    try {
      return await route(request);
    } catch (error) {
      return answerUnexpectedError(log, request, error);
    }
  };

  return {
    close: () => {
      pending.clear();
    },
    fetch,
  };
};
