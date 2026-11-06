import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdminListener } from './admin-listener.ts';
import type { AdminListener } from './admin-listener.ts';
import type { ClientMetadata } from './client-metadata.ts';
import { parseConfig } from './config.ts';
import type { Log } from './log.ts';
import type { FetchMetadataDocument } from './metadata-document.ts';
import { s256Challenge } from './pkce.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';

const PUBLIC = 'https://modgud.example.com';
const ADMIN = 'https://modgud.example.ts.net';
const ADMIN_HOST = 'modgud.example.ts.net';
const RESOURCE = `${PUBLIC}/stub/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = s256Challenge(VERIFIER);
const METADATA_URL = 'https://chatgpt.com/oauth/client.json';
const MINUTE = 60_000;

const BROWSER = {
  Host: ADMIN_HOST,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-User': '?1',
};

const config = parseConfig(`
  [harness]
  bearer_token_sha256 = "${'a'.repeat(64)}"
  service = "stub"

  [public]
  base_url = "${PUBLIC}"

  [admin]
  base_url = "${ADMIN}"
  host = "100.64.0.1"

  [services.stub]
  command = "stub"
`);

let directory = '';
let store: Store;
let listener: AdminListener;
let lines: string[] = [];
let clock = 0;
let metadataFetches: string[] = [];
let documents = new Map<string, ClientMetadata>();

// Stands in for the safe fetcher: records each fetch and answers from `documents`.
const fetchMetadataDocument: FetchMetadataDocument = async (clientId) => {
  metadataFetches.push(clientId);
  return documents.get(clientId);
};

const start = async () => {
  directory = await mkdtemp(join(tmpdir(), 'modgud-admin-'));
  store = await openStore({
    maxTokenLifetimeDays: 30,
    now: () => clock,
    path: join(directory, 'modgud.sqlite'),
    resource: RESOURCE,
    warn: () => undefined,
  });
  const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  listener = createAdminListener({ config, fetchMetadataDocument, log, now: () => clock, store });
};

beforeEach(async () => {
  clock = Date.now();
  lines = [];
  metadataFetches = [];
  documents = new Map();
  await start();
});

afterEach(async () => {
  listener.close();
  store.close();
  await rm(directory, { force: true, recursive: true });
});

const register = (redirectUris = [REDIRECT], clientName: string | undefined = 'Claude') =>
  store.registerClient({ clientName, redirectUris })?.clientId ?? '';

const authorizeQuery = (clientId: string, overrides: Record<string, string | undefined> = {}) => {
  const parameters: Record<string, string | undefined> = {
    client_id: clientId,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 'state-123',
    ...overrides,
  };
  return new URLSearchParams(
    Object.entries(parameters).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : [[name, value]],
    ),
  ).toString();
};

const get = async (query: string, headers: Record<string, string> = BROWSER) =>
  listener.fetch(new Request(`${ADMIN}/authorize?${query}`, { headers }));

// Opens the Approval page as a browser does, returning the pending request's
// identifier and the cookie to send back.
const openApproval = async (query: string) => {
  const response = await get(query);
  const html = await response.text();
  const id = /name="request" value="([^"]+)"/u.exec(html)?.[1] ?? '';
  const setCookie = response.headers.get('set-cookie') ?? '';
  return { cookie: setCookie.split(';')[0] ?? '', html, id, response, setCookie };
};

const post = async (
  fields: Record<string, string>,
  { cookie, origin = ADMIN }: { cookie: string | undefined; origin?: string | null },
) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Host: ADMIN_HOST,
  };
  if (origin !== null) {
    headers.Origin = origin;
  }
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  return listener.fetch(
    new Request(`${ADMIN}/authorize`, {
      body: new URLSearchParams(fields),
      headers,
      method: 'POST',
    }),
  );
};

const approveWith = async (
  approval: { cookie: string; id: string },
  pairingCode: string,
  origin: string | null = ADMIN,
) =>
  post(
    { action: 'approve', pairing_code: pairingCode, request: approval.id },
    { cookie: approval.cookie, origin },
  );

const location = (response: Response) => new URL(response.headers.get('location') ?? 'about:blank');

describe('the Admin listener', () => {
  test.each([
    ['another host', 'evil.example'],
    ['the tailnet address', '100.64.0.1:8471'],
    ['the host with the default port written out', `${ADMIN_HOST}:443`],
    ['the host in another case', 'Modgud.example.ts.net'],
  ])('answers HTTP 421 to a request for %s', async (_, host) => {
    const response = await get(authorizeQuery(register()), { ...BROWSER, Host: host });

    expect(response.status).toBe(421);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('answers HTTP 421 to a request without a Host header', async () => {
    const response = await listener.fetch(
      new Request(`${ADMIN}/authorize?${authorizeQuery(register())}`),
    );

    expect(response.status).toBe(421);
  });

  test.each([
    '/',
    '/authorize/',
    '/.well-known/oauth-authorization-server',
    '/oauth/token',
    '/stub/mcp',
  ])('answers HTTP 404 for %s', async (path) => {
    const response = await listener.fetch(new Request(`${ADMIN}${path}`, { headers: BROWSER }));

    expect(response.status).toBe(404);
  });

  test('answers HTTP 405 to another method on /authorize', async () => {
    const response = await listener.fetch(
      new Request(`${ADMIN}/authorize`, { headers: BROWSER, method: 'PUT' }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
  });
});

describe('the Approval page', () => {
  test('leads with the redirect host, then shows the redirect URI, the Service, and the client-chosen name', async () => {
    const { html, id, response } = await openApproval(authorizeQuery(register()));

    expect(response.status).toBe(200);
    const host = html.indexOf('claude.ai</p>');
    const uri = html.indexOf(REDIRECT);
    const service = html.indexOf(RESOURCE);
    const name = html.indexOf('Claude</dd>');
    expect(host).toBeGreaterThan(0);
    expect(host).toBeLessThan(uri);
    expect(uri).toBeLessThan(service);
    expect(service).toBeLessThan(name);
    expect(html).toContain('chosen by the client');
    expect(html).toContain('name="pairing_code"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
    expect(html).not.toContain('<script');
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('carries only the pending request identifier in its form', async () => {
    const { html, id } = await openApproval(authorizeQuery(register()));

    expect(
      [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)"/gu)].map((match) => [
        match[1],
        match[2],
      ]),
    ).toEqual([['request', id]]);
    expect(html).not.toContain('state-123');
    expect(html).not.toContain(CHALLENGE);
  });

  test('carries the page headers, with the redirect URI origin as a form action', async () => {
    const { response } = await openApproval(authorizeQuery(register()));

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'",
    );
  });

  test('leaves form-action out of the policy when the redirect host is an IP address', async () => {
    const loopback = 'http://127.0.0.1:33418/callback';
    const { response } = await openApproval(
      authorizeQuery(register([loopback]), { redirect_uri: loopback }),
    );

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
  });

  test('names no extra form action for a stored redirect origin with characters outside a host name', async () => {
    const injected = 'https://evil.example;sandbox,script-src/cb';
    const { response } = await openApproval(
      authorizeQuery(register([injected]), { redirect_uri: injected }),
    );

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  test('names a localhost redirect origin in form-action, port included', async () => {
    const loopback = 'http://localhost:33418/callback';
    const { response } = await openApproval(
      authorizeQuery(register([loopback]), { redirect_uri: loopback }),
    );

    expect(response.headers.get('content-security-policy')).toContain(
      "form-action 'self' http://localhost:33418;",
    );
  });

  test('sets a cookie for the pending request, named by its identifier, with every required attribute', async () => {
    const { id, setCookie } = await openApproval(authorizeQuery(register()));

    expect(setCookie).toMatch(
      new RegExp(
        `^__Host-modgud-pending-${id.slice(0, 8)}=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600$`,
        'u',
      ),
    );
    expect(setCookie).not.toContain('Domain');
  });

  test('gives each pending request its own cookie, so tabs do not overwrite each other', async () => {
    const clientId = register();
    const first = await openApproval(authorizeQuery(clientId));
    const second = await openApproval(authorizeQuery(clientId));

    expect(first.cookie.split('=')[0]).not.toBe(second.cookie.split('=')[0]);
    const code = store.mintPairingCode(10).code;
    expect((await approveWith(first, code)).status).toBe(303);
  });

  test('escapes the client name and strips control and bidirectional-formatting characters', async () => {
    const override = String.fromCodePoint(8238); // U+202E RIGHT-TO-LEFT OVERRIDE
    const isolate = String.fromCodePoint(8294); // U+2066 LEFT-TO-RIGHT ISOLATE
    const name = `<img src=x onerror=alert(1)>"&'${override}moc.evil${isolate}\u0007end`;
    const { html } = await openApproval(authorizeQuery(register([REDIRECT], name)));

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;moc.evilend');
    expect(html).not.toContain('<img');
    expect(html).not.toContain(override);
    expect(html).not.toContain(isolate);
    expect(html).not.toContain('\u0007');
  });

  test('shows a loopback redirect URI with a warning that the code goes to a program on this device', async () => {
    const loopback = 'http://127.0.0.1:33418/callback';
    const { html } = await openApproval(
      authorizeQuery(register([loopback]), { redirect_uri: loopback }),
    );

    expect(html).toContain('a program on the device you are approving from');
  });

  test('uses the one registered redirect URI when the request names none', async () => {
    const { response } = await openApproval(
      authorizeQuery(register(), { redirect_uri: undefined }),
    );

    expect(response.status).toBe(200);
  });

  test('accepts a loopback redirect URI that differs from the registered one only in its port, and answers there', async () => {
    const clientId = register(['http://127.0.0.1:33418/callback']);
    const requested = 'http://127.0.0.1:50999/callback';
    const approval = await openApproval(authorizeQuery(clientId, { redirect_uri: requested }));

    const response = await approveWith(approval, store.mintPairingCode(10).code);

    expect(response.status).toBe(303);
    expect(`${location(response).origin}${location(response).pathname}`).toBe(requested);
  });

  test('defaults an absent resource to the harness Service and accepts it named', async () => {
    const clientId = register();

    expect((await get(authorizeQuery(clientId))).status).toBe(200);
    expect((await get(authorizeQuery(clientId, { resource: RESOURCE }))).status).toBe(200);
  });

  test('accepts an empty scope', async () => {
    expect((await get(authorizeQuery(register(), { scope: '' }))).status).toBe(200);
  });
});

describe('a top-level navigation', () => {
  test('is required before a pending request exists', async () => {
    const response = await get(authorizeQuery(register()), {
      Host: ADMIN_HOST,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('name="request"');
  });

  test.each([
    ['an iframe', { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' }],
    ['an image', { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors' }],
    ['only a Sec-Fetch-Site header', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('refuses %s', async (_, fetchHeaders) => {
    const response = await get(authorizeQuery(register()), { Host: ADMIN_HOST, ...fetchHeaders });

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('passes a request with no Sec-Fetch- headers, as older Safari sends', async () => {
    const response = await get(authorizeQuery(register()), { Host: ADMIN_HOST });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).not.toBeNull();
  });

  test('is required before a metadata document is fetched', async () => {
    const response = await get(authorizeQuery(METADATA_URL), {
      Host: ADMIN_HOST,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
    });

    expect(response.status).toBe(400);
    expect(metadataFetches).toEqual([]);
  });
});

// The parts of a page that would send the person anywhere.
const expectNoRedirect = async (response: Response) => {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.get('location')).toBeNull();
  const html = await response.text();
  expect(html).not.toContain('<a ');
  expect(html).not.toContain('http-equiv');
  return html;
};

describe('a request whose client or redirect URI does not resolve', () => {
  test('shows an error page telling the person to remove and re-add the connector for an unknown client_id', async () => {
    const html = await expectNoRedirect(await get(authorizeQuery('unknown-client-id')));

    expect(html).toContain('Remove the connector from the client and add it again');
  });

  test('shows an error page for a redirect URI the client did not register', async () => {
    await expectNoRedirect(
      await get(authorizeQuery(register(), { redirect_uri: 'https://evil.example/cb' })),
    );
  });

  test('shows an error page when the request names no redirect URI and the client has several', async () => {
    const clientId = register([REDIRECT, 'https://claude.ai/other']);

    await expectNoRedirect(await get(authorizeQuery(clientId, { redirect_uri: undefined })));
  });

  test('shows an error page for a missing client_id', async () => {
    await expectNoRedirect(await get(authorizeQuery('', {})));
  });

  test('shows an error page, never a link, even when the rest of the request is also invalid', async () => {
    await expectNoRedirect(
      await get(
        authorizeQuery(register(), { redirect_uri: 'https://evil.example/cb', scope: 'mcp' }),
      ),
    );
  });

  test('shows one generic error page when a metadata document cannot be used', async () => {
    const html = await expectNoRedirect(await get(authorizeQuery(METADATA_URL)));

    expect(metadataFetches).toEqual([METADATA_URL]);
    expect(html).toContain('could not load this client&#39;s details');
  });

  test('refuses a query string over 8 KiB', async () => {
    const clientId = register();
    const fits = authorizeQuery(clientId, { state: undefined });
    const padded = (size: number) => `${fits}&x=${'a'.repeat(size - fits.length - 3)}`;

    expect((await get(padded(8 * 1024))).status).toBe(200);
    await expectNoRedirect(await get(padded(8 * 1024 + 1)));
  });

  test('refuses a repeated parameter', async () => {
    await expectNoRedirect(await get(`${authorizeQuery(register())}&client_id=other`));
  });
});

describe('a request that resolves but is otherwise invalid', () => {
  test.each([
    ['another response type', { response_type: 'token' }, 'unsupported_response_type'],
    ['no response type', { response_type: undefined }, 'invalid_request'],
    ['no code challenge', { code_challenge: undefined }, 'invalid_request'],
    ['a short code challenge', { code_challenge: CHALLENGE.slice(1) }, 'invalid_request'],
    [
      'a code challenge outside base64url',
      { code_challenge: `${CHALLENGE.slice(1)}+` },
      'invalid_request',
    ],
    ['the plain method', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no method', { code_challenge_method: undefined }, 'invalid_request'],
    ['a scope', { scope: 'mcp' }, 'invalid_scope'],
    ['another resource', { resource: `${PUBLIC}/other/mcp` }, 'invalid_target'],
  ])(
    'with %s shows an error page with a Return link carrying %p, state, and iss',
    async (_, overrides, error) => {
      const response = await get(authorizeQuery(register(), overrides));

      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      const href = /<a href="([^"]+)">Return to claude\.ai<\/a>/u
        .exec(html)?.[1]
        ?.replaceAll('&amp;', '&');
      expect(href).toBeDefined();
      const link = new URL(href ?? '');
      expect(`${link.origin}${link.pathname}`).toBe(REDIRECT);
      expect(link.searchParams.get('error')).toBe(error);
      expect(link.searchParams.get('iss')).toBe(PUBLIC);
      expect(link.searchParams.get('state')).toBe('state-123');
    },
  );

  test('with a state over 1,024 characters leaves the state out of the Return link', async () => {
    const response = await get(authorizeQuery(register(), { state: 's'.repeat(1025) }));

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain('s'.repeat(1025));
    const href = /<a href="([^"]+)">Return to claude\.ai<\/a>/u
      .exec(html)?.[1]
      ?.replaceAll('&amp;', '&');
    const link = new URL(href ?? '');
    expect(link.searchParams.get('error')).toBe('invalid_request');
    expect(link.searchParams.get('iss')).toBe(PUBLIC);
    expect(link.searchParams.has('state')).toBe(false);
  });

  test('accepts a state of 1,024 characters', async () => {
    expect((await get(authorizeQuery(register(), { state: 's'.repeat(1024) }))).status).toBe(200);
  });
});

describe('pending requests', () => {
  test('hold at most 50, dropping the oldest', async () => {
    const clientId = register();
    const approvals = [];
    for (let index = 0; index < 51; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      approvals.push(await openApproval(authorizeQuery(clientId)));
    }
    const [oldest, second] = approvals;
    const code = store.mintPairingCode(10).code;

    const dropped = await approveWith(oldest ?? { cookie: '', id: '' }, code);
    expect(dropped.status).toBe(400);
    expect(await dropped.text()).toContain('expired or already ended');
    expect((await approveWith(second ?? { cookie: '', id: '' }, code)).status).toBe(303);
  });

  test('expire after 10 minutes, without counting as a failure', async () => {
    const approval = await openApproval(authorizeQuery(register()));
    const code = store.mintPairingCode(60).code;

    clock += 10 * MINUTE;
    const expired = await approveWith(approval, code);

    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain('expired or already ended');
    expect(lines.join('\n')).not.toContain('wrong Pairing code');
  });

  test('last until just before 10 minutes', async () => {
    const approval = await openApproval(authorizeQuery(register()));
    const code = store.mintPairingCode(60).code;

    clock += 10 * MINUTE - 1;
    expect((await approveWith(approval, code)).status).toBe(303);
  });

  test('are forgotten on close', async () => {
    const approval = await openApproval(authorizeQuery(register()));
    listener.close();

    expect((await approveWith(approval, store.mintPairingCode(10).code)).status).toBe(400);
  });
});

// The cookies of the pending request under test and of another one.
type Cookies = { approval: string; other: string };

describe('POST /authorize', () => {
  test.each([
    ['no Origin', null],
    ['another Origin', 'https://evil.example'],
    ['the null Origin', 'null'],
    ['the Public listener origin', PUBLIC],
  ])('answers HTTP 403 with %s, without counting a failure', async (_, origin) => {
    const approval = await openApproval(authorizeQuery(register()));
    for (let index = 0; index < 6; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      expect((await approveWith(approval, 'WRONG-CODE', origin)).status).toBe(403);
    }

    expect((await approveWith(approval, store.mintPairingCode(10).code)).status).toBe(303);
  });

  test.each([
    ['no cookie', () => undefined],
    [
      'a cookie with the wrong value',
      ({ approval }: Cookies) => `${approval.split('=')[0] ?? ''}=${'x'.repeat(43)}`,
    ],
    [
      'a cookie of the same length with a character that UTF-8 writes in two bytes',
      ({ approval }: Cookies) => `${approval.split('=')[0] ?? ''}=${'\u00e9'.repeat(43)}`,
    ],
    ['another pending request cookie', ({ other }: Cookies) => other],
  ])('answers HTTP 403 with %s, without counting a failure', async (_, cookieFor) => {
    const clientId = register();
    const approval = await openApproval(authorizeQuery(clientId));
    const other = await openApproval(authorizeQuery(clientId));
    const cookie = cookieFor({ approval: approval.cookie, other: other.cookie });
    for (let index = 0; index < 6; index += 1) {
      const response =
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await post(
          { action: 'approve', pairing_code: 'WRONG-CODE', request: approval.id },
          { cookie },
        );
      expect(response.status).toBe(403);
    }

    expect((await approveWith(approval, store.mintPairingCode(10).code)).status).toBe(303);
  });

  test('shows an error page for an unknown pending request', async () => {
    const response = await post(
      { action: 'approve', pairing_code: 'WRONG-CODE', request: 'unknown' },
      { cookie: undefined },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('expired or already ended');
  });

  test('Deny redirects with access_denied, state, and iss, and ends the pending request', async () => {
    const approval = await openApproval(authorizeQuery(register()));

    const response = await post(
      { action: 'deny', request: approval.id },
      { cookie: approval.cookie },
    );

    expect(response.status).toBe(303);
    expect(location(response).href).toBe(
      `${REDIRECT}?error=access_denied&iss=${encodeURIComponent(PUBLIC)}&state=state-123`,
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(lines.some((line) => line.includes('Denied client'))).toBe(true);
    expect((await approveWith(approval, store.mintPairingCode(10).code)).status).toBe(400);
  });

  test('Approve with a valid code redirects with code, state, and iss; the code redeems for tokens', async () => {
    const clientId = register();
    const approval = await openApproval(authorizeQuery(clientId));
    const pairingCode = store.mintPairingCode(10).code;

    const response = await approveWith(approval, pairingCode.toLowerCase().replace('-', ' '));

    expect(response.status).toBe(303);
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const redirect = location(response);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('iss')).toBe(PUBLIC);
    expect(redirect.searchParams.get('state')).toBe('state-123');
    const code = redirect.searchParams.get('code') ?? '';
    const tokens = store.exchangeAuthorizationCode({
      clientId,
      code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });
    expect(tokens.ok).toBe(true);
    // The pending request has ended.
    expect((await approveWith(approval, store.mintPairingCode(10).code)).status).toBe(400);
  });

  test('keeps the redirect URI query as registered and leaves out an absent state', async () => {
    const withQuery = 'https://app.example.com/cb?tenant=a%20b';
    const approval = await openApproval(
      authorizeQuery(register([withQuery]), { redirect_uri: withQuery, state: undefined }),
    );

    const response = await approveWith(approval, store.mintPairingCode(10).code);

    expect(response.headers.get('location')).toStartWith(`${withQuery}&code=`);
    expect(location(response).searchParams.has('state')).toBe(false);
  });

  test('records that the request named no redirect URI, so the token request need not repeat it', async () => {
    const clientId = register();
    const approval = await openApproval(authorizeQuery(clientId, { redirect_uri: undefined }));
    const response = await approveWith(approval, store.mintPairingCode(10).code);

    const tokens = store.exchangeAuthorizationCode({
      clientId,
      code: location(response).searchParams.get('code') ?? '',
      codeVerifier: VERIFIER,
    });
    expect(tokens.ok).toBe(true);
  });

  test('shows the page again with an error for a wrong code, and the fifth failure ends the request', async () => {
    const approval = await openApproval(authorizeQuery(register()));
    for (let failure = 1; failure <= 4; failure += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      const response = await approveWith(approval, 'ZZZZ-ZZZZ');
      expect(response.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      const html = await response.text();
      expect(html).toContain('That Pairing code is wrong');
      expect(html).toContain(`value="${approval.id}"`);
    }

    const fifth = await approveWith(approval, 'ZZZZ-ZZZZ');
    expect(fifth.status).toBe(400);
    expect(await fifth.text()).toContain('Start again from the client');

    const after = await approveWith(approval, store.mintPairingCode(10).code);
    expect(await after.text()).toContain('expired or already ended');
  });

  test('counts an expired or spent code as a failure', async () => {
    const clientId = register();
    const spent = store.mintPairingCode(10).code;
    expect((await approveWith(await openApproval(authorizeQuery(clientId)), spent)).status).toBe(
      303,
    );
    const expiring = store.mintPairingCode(1).code;
    clock += MINUTE;

    const approval = await openApproval(authorizeQuery(clientId));
    expect((await approveWith(approval, spent)).status).toBe(400);
    expect((await approveWith(approval, expiring)).status).toBe(400);
    expect(lines.filter((line) => line.includes('wrong Pairing code'))).toHaveLength(2);
  });

  test('refuses every code after 20 failures in 10 minutes, neither checking nor counting them', async () => {
    const clientId = register();
    for (let request = 0; request < 5; request += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      const approval = await openApproval(authorizeQuery(clientId));
      for (let failure = 0; failure < 4; failure += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await approveWith(approval, 'ZZZZ-ZZZZ');
        clock += 1000;
      }
    }
    const approval = await openApproval(authorizeQuery(clientId));
    const valid = store.mintPairingCode(60).code;

    // Refused, without spending the valid code or counting toward this request's five.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      const refused = await approveWith(approval, valid);
      expect(refused.status).toBe(429);
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      expect(await refused.text()).toContain('Too many wrong Pairing codes');
    }
    expect(lines.some((line) => line.includes('20 wrong codes in the last 10 minutes'))).toBe(true);

    // The first failure leaves the window; the same code then approves.
    clock += 10 * MINUTE - 20 * 1000 + 1;
    const fresh = await openApproval(authorizeQuery(clientId));
    expect((await approveWith(fresh, valid)).status).toBe(303);
  });

  test('refuses a body over the form limit', async () => {
    const approval = await openApproval(authorizeQuery(register()));

    const response = await post(
      { action: 'approve', pad: 'x'.repeat(5000), pairing_code: 'x', request: approval.id },
      { cookie: approval.cookie },
    );
    expect(response.status).toBe(400);
  });

  test('ends the request with an error page when its registration is gone', async () => {
    const clientId = register();
    const approval = await openApproval(authorizeQuery(clientId));
    // An unapproved registration is forgotten after an hour.
    clock += 61 * MINUTE;
    store.removeExpired();
    // The pending request would also have expired, so keep the clock where
    // the registration is gone but the request is not.
    clock -= 55 * MINUTE;

    const response = await approveWith(approval, store.mintPairingCode(10).code);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Remove the connector');
  });
});

describe('an unexpected error', () => {
  test('answers a plain HTTP 500 and logs the error without its stack', async () => {
    const failing: Store = {
      ...store,
      findClient: () => {
        throw new Error('disk I/O error');
      },
    };
    const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
    const broken = createAdminListener({ config, fetchMetadataDocument, log, store: failing });

    const response = await broken.fetch(
      new Request(`${ADMIN}/authorize?${authorizeQuery('some-client')}`, { headers: BROWSER }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Internal Server Error');
    expect(lines).toEqual(['Answered GET /authorize with HTTP 500: disk I/O error']);
    broken.close();
  });
});

describe('logging', () => {
  test('logs approvals, denials, and failed codes by short prefixes, never a code', async () => {
    const clientId = register();
    const failed = await openApproval(authorizeQuery(clientId));
    await approveWith(failed, 'ZZZZ-ZZZZ');
    const pairingCode = store.mintPairingCode(10).code;
    const response = await approveWith(failed, pairingCode);
    const code = location(response).searchParams.get('code') ?? '';
    const denied = await openApproval(authorizeQuery(clientId));
    await post({ action: 'deny', request: denied.id }, { cookie: denied.cookie });

    const log = lines.join('\n');
    expect(log).toContain(`wrong Pairing code was entered for client ${clientId.slice(0, 8)}`);
    expect(log).toMatch(
      new RegExp(
        `Approved client ${clientId.slice(0, 8)} \\(Claude\\) as authorization [\\w-]{8}\\.`,
        'u',
      ),
    );
    expect(log).toContain(`Denied client ${clientId.slice(0, 8)}.`);
    expect(log).not.toContain(clientId);
    expect(log).not.toContain(pairingCode);
    expect(log).not.toContain(pairingCode.replace('-', ''));
    expect(log).not.toContain(code);
    expect(log).not.toContain(failed.cookie.split('=')[1] ?? '');
    expect(log).not.toContain(failed.id);
  });
});

describe('a client with a metadata document', () => {
  const DOCUMENT: ClientMetadata = {
    clientName: 'ChatGPT',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  };

  test("shows the client_id URL's host and approves with the URL as client_id", async () => {
    documents.set(METADATA_URL, DOCUMENT);
    const approval = await openApproval(
      authorizeQuery(METADATA_URL, {
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      }),
    );

    expect(approval.response.status).toBe(200);
    expect(approval.html).toContain('Client metadata from</dt><dd>chatgpt.com</dd>');
    expect(approval.html).not.toContain('class="warning"');
    const response = await approveWith(approval, store.mintPairingCode(10).code);
    expect(response.status).toBe(303);
    expect(lines.some((line) => line.includes('Approved client chatgpt.com (ChatGPT)'))).toBe(true);
  });

  test('warns when the redirect host differs from the client_id host', async () => {
    documents.set(METADATA_URL, {
      clientName: 'ChatGPT',
      redirectUris: ['https://elsewhere.example/cb'],
    });
    const { html } = await openApproval(
      authorizeQuery(METADATA_URL, { redirect_uri: 'https://elsewhere.example/cb' }),
    );

    expect(html).toContain('class="warning"');
    expect(html).toContain(
      '<strong>elsewhere.example</strong>, not to <strong>chatgpt.com</strong>',
    );
  });
});
