import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from './bearer.ts';
import { parseConfig } from './config.ts';
import { s256Challenge } from './pkce.ts';
import { createPublicListener } from './public-listener.ts';
import type { PublicListener } from './public-listener.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';

// The OAuth endpoints of the Public listener (docs/oauth.md), driven through
// the listener's fetch handler with a real store and an injected clock.

const PUBLIC = 'https://modgud.example.com';
const ADMIN = 'https://modgud.example.ts.net';
const RESOURCE = `${PUBLIC}/stub/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CIMD_CLIENT = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const START = Date.parse('2026-11-06T12:00:00Z');
const MINUTE = 60_000;

const config = parseConfig(`
  [harness]
  bearer_token_sha256 = "${sha256Hex('harness-token')}"
  service = "stub"

  [public]
  base_url = "${PUBLIC}"

  [admin]
  base_url = "${ADMIN}"
  host = "100.64.0.1"

  [services.stub]
  command = "true"

  [services.other]
  command = "true"
`);

let directory = '';
let clock = START;
let store: Store;
let listener: PublicListener;
let lines: string[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'modgud-oauth-'));
  clock = START;
  lines = [];
  store = await openStore({
    maxTokenLifetimeDays: 30,
    now: () => clock,
    path: join(directory, 'modgud.sqlite'),
    resource: RESOURCE,
    warn: () => undefined,
  });
  listener = createPublicListener({
    config,
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    now: () => clock,
    parentEnvironment: {},
    store,
  });
});

afterEach(async () => {
  await listener.close();
  store.close();
  await rm(directory, { force: true, recursive: true });
});

// Sends a request through the listener as if it arrived from `peer`.
const call = async (path: string, init: RequestInit = {}, peer = '198.51.100.1') =>
  listener.fetch(new Request(`http://127.0.0.1:8470${path}`, init), {
    requestIP: () => ({ address: peer }),
  });

const register = async (
  metadata: unknown = { client_name: 'Claude', redirect_uris: [REDIRECT] },
  { headers = {}, peer = '198.51.100.1' }: { headers?: Record<string, string>; peer?: string } = {},
) =>
  call(
    '/oauth/register',
    {
      body: JSON.stringify(metadata),
      headers: { 'Content-Type': 'application/json', ...headers },
      method: 'POST',
    },
    peer,
  );

const token = async (parameters: Record<string, string>) =>
  call('/oauth/token', {
    body: new URLSearchParams(parameters).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });

const errorOf = async (response: Response) => {
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return ((await response.json()) as { error: string }).error;
};

// Approves a client through the store and returns the authorization code.
const approve = (
  clientId: string,
  { requestedRedirectUri = REDIRECT }: { requestedRedirectUri?: string | null } = {},
): { authorizationId: string; code: string } => {
  const { code: pairingCode } = store.mintPairingCode(10);
  const approved = store.approve({
    clientId,
    codeChallenge: s256Challenge(VERIFIER),
    pairingCode,
    redirectUri: REDIRECT,
    requestedRedirectUri,
  });
  if (approved === undefined) {
    throw new Error('The approval failed.');
  }
  return approved;
};

const registeredClient = () => {
  const client = store.registerClient({ redirectUris: [REDIRECT] });
  if (client === undefined) {
    throw new Error('The registration was refused.');
  }
  return client.clientId;
};

const exchange = (clientId: string, code: string, extra: Record<string, string> = {}) =>
  token({
    client_id: clientId,
    code,
    code_verifier: VERIFIER,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
    ...extra,
  });

type Tokens = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
};

describe('metadata', () => {
  test("serves each Service's protected-resource metadata from the configured base URL", async () => {
    for (const service of ['stub', 'other']) {
      // oxlint-disable-next-line no-await-in-loop -- one Service at a time
      const response = await call(`/.well-known/oauth-protected-resource/${service}/mcp`, {
        headers: { Host: 'attacker.example' },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      // oxlint-disable-next-line no-await-in-loop -- one Service at a time
      expect(await response.json()).toEqual({
        authorization_servers: [PUBLIC],
        bearer_methods_supported: ['header'],
        resource: `${PUBLIC}/${service}/mcp`,
      });
    }
  });

  test('answers the root protected-resource metadata and an unknown Service with 404', async () => {
    const root = await call('/.well-known/oauth-protected-resource');
    const unknown = await call('/.well-known/oauth-protected-resource/missing/mcp');

    expect(root.status).toBe(404);
    expect(root.headers.get('cache-control')).toBe('no-store');
    expect(unknown.status).toBe(404);
  });

  test('serves the authorization-server metadata', async () => {
    const response = await call('/.well-known/oauth-authorization-server', {
      headers: { Host: 'attacker.example' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      authorization_endpoint: `${ADMIN}/authorize`,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: PUBLIC,
      registration_endpoint: `${PUBLIC}/oauth/register`,
      response_types_supported: ['code'],
      token_endpoint: `${PUBLIC}/oauth/token`,
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

describe('routing', () => {
  test.each([
    ['POST', '/.well-known/oauth-authorization-server', 'GET'],
    ['DELETE', '/.well-known/oauth-protected-resource/stub/mcp', 'GET'],
    ['GET', '/oauth/register', 'POST'],
    ['GET', '/oauth/token', 'POST'],
  ])('answers %s %s with 405', async (method, path, allowed) => {
    const response = await call(path, { method });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allowed);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test.each([
    '/',
    '/oauth',
    '/oauth/authorize',
    '/authorize',
    '/stub',
    '/.well-known/openid-configuration',
  ])('answers %s with 404', async (path) => {
    const response = await call(path);

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('serves no CORS headers, even to a request with an Origin', async () => {
    const responses = await Promise.all([
      call('/.well-known/oauth-authorization-server', { headers: { Origin: 'https://claude.ai' } }),
      call('/oauth/token', { headers: { Origin: 'https://claude.ai' }, method: 'OPTIONS' }),
      register(undefined, { headers: { Origin: 'https://claude.ai' } }),
    ]);

    for (const response of responses) {
      expect(
        [...response.headers.keys()].filter((name) => name.startsWith('access-control-')),
      ).toEqual([]);
    }
  });
});

describe('dynamic client registration', () => {
  test('registers a client and answers 201 with its public metadata', async () => {
    const response = await register({
      client_name: 'Claude',
      client_secret: 'not-echoed',
      logo_uri: 'https://claude.ai/logo.png',
      redirect_uris: [REDIRECT],
      scope: 'everything',
      token_endpoint_auth_method: 'client_secret_post',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      client_id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      client_id_issued_at: START / 1000,
      client_name: 'Claude',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [REDIRECT],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    const clientId = String(body.client_id);
    expect(store.findClient(clientId)?.redirectUris).toEqual([REDIRECT]);
    expect(lines.some((line) => line.includes(clientId.slice(0, 8)))).toBe(true);
    expect(lines.some((line) => line.includes(clientId))).toBe(false);
  });

  test('leaves out client_name when none was given', async () => {
    const body = (await (await register({ redirect_uris: [REDIRECT] })).json()) as object;

    expect(body).not.toHaveProperty('client_name');
  });

  test('refuses an invalid redirect URI with invalid_redirect_uri', async () => {
    const response = await register({ redirect_uris: ['http://example.com/cb'] });

    expect(await errorOf(response)).toBe('invalid_redirect_uri');
  });

  test('refuses invalid metadata with invalid_client_metadata', async () => {
    const response = await register({ grant_types: ['implicit'], redirect_uris: [REDIRECT] });

    expect(await errorOf(response)).toBe('invalid_client_metadata');
  });

  test('refuses a body that is not JSON, or not sent as JSON, with invalid_client_metadata', async () => {
    const malformed = await call('/oauth/register', {
      body: '{',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const asForm = await call('/oauth/register', {
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });

    expect(await errorOf(malformed)).toBe('invalid_client_metadata');
    expect(await errorOf(asForm)).toBe('invalid_client_metadata');
  });

  test('refuses a body over 16 KiB', async () => {
    const response = await register({
      padding: 'x'.repeat(16 * 1024),
      redirect_uris: [REDIRECT],
    });

    expect(await errorOf(response)).toBe('invalid_client_metadata');
  });

  test('allows 10 registrations from one source in 10 minutes, then answers 429 with Retry-After', async () => {
    await register(undefined, { peer: '203.0.113.5' });
    clock += 2 * MINUTE;
    for (let index = 1; index < 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations count in order
      expect((await register(undefined, { peer: '203.0.113.5' })).status).toBe(201);
    }

    const refused = await register(undefined, { peer: '203.0.113.5' });

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('480');
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect((await register(undefined, { peer: '203.0.113.6' })).status).toBe(201);
    clock += 8 * MINUTE;
    expect((await register(undefined, { peer: '203.0.113.5' })).status).toBe(201);
  });

  test('counts a source by CF-Connecting-IP when present, not by the peer address', async () => {
    for (let index = 0; index < 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations count in order
      await register(undefined, {
        headers: { 'CF-Connecting-IP': '203.0.113.9' },
        peer: `127.0.0.${String(index + 1)}`,
      });
    }

    const sameSource = await register(undefined, {
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
      peer: '127.0.0.99',
    });
    const otherSource = await register(undefined, {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
      peer: '127.0.0.1',
    });

    expect(sameSource.status).toBe(429);
    expect(otherSource.status).toBe(201);
  });

  test('counts a source by the peer address when CF-Connecting-IP is empty', async () => {
    for (let index = 0; index < 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations count in order
      await register(undefined, { headers: { 'CF-Connecting-IP': '' }, peer: '203.0.113.20' });
    }

    const samePeer = await register(undefined, {
      headers: { 'CF-Connecting-IP': '' },
      peer: '203.0.113.20',
    });
    const otherPeer = await register(undefined, {
      headers: { 'CF-Connecting-IP': '' },
      peer: '203.0.113.21',
    });

    expect(samePeer.status).toBe(429);
    expect(otherPeer.status).toBe(201);
  });

  test('counts IPv6 sources by their /64 prefix', async () => {
    for (let index = 0; index < 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations count in order
      await register(undefined, { peer: `2001:db8:1:2::${(index + 1).toString(16)}` });
    }

    expect((await register(undefined, { peer: '2001:db8:1:2:ffff::1' })).status).toBe(429);
    expect((await register(undefined, { peer: '2001:db8:1:3::1' })).status).toBe(201);
  });

  test('allows 100 registrations overall in 10 minutes, then answers 429 with Retry-After', async () => {
    for (let index = 0; index < 100; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations count in order
      expect((await register(undefined, { peer: `192.0.2.${String(index)}` })).status).toBe(201);
    }
    clock += MINUTE;

    const refused = await register(undefined, { peer: '198.51.100.200' });

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('540');
  });

  test('answers 503 and stores nothing when every stored registration has a live authorization', async () => {
    const full = await openStore({
      maxTokenLifetimeDays: 30,
      now: () => clock,
      path: join(directory, 'full.sqlite'),
      resource: RESOURCE,
      storedClients: 1,
      warn: () => undefined,
    });
    const fullListener = createPublicListener({
      config,
      log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
      now: () => clock,
      parentEnvironment: {},
      store: full,
    });
    try {
      const { client_id: clientId } = (await (
        await fullListener.fetch(
          new Request(`${PUBLIC}/oauth/register`, {
            body: JSON.stringify({ redirect_uris: [REDIRECT] }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          }),
        )
      ).json()) as { client_id: string };
      const { code: pairingCode } = full.mintPairingCode(10);
      full.approve({
        clientId,
        codeChallenge: s256Challenge(VERIFIER),
        pairingCode,
        redirectUri: REDIRECT,
        requestedRedirectUri: null,
      });
      lines = [];

      const refused = await fullListener.fetch(
        new Request(`${PUBLIC}/oauth/register`, {
          body: JSON.stringify({ redirect_uris: [REDIRECT] }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
      );

      expect(refused.status).toBe(503);
      expect(refused.headers.get('cache-control')).toBe('no-store');
      expect(lines).toEqual([]);
      expect(full.findClient(clientId)).toBeDefined();
    } finally {
      await fullListener.close();
      full.close();
    }
  });

  test('answers a plain HTTP 500 when the store fails, logging the error without its stack', async () => {
    const failing: Store = {
      ...store,
      registerClient: () => {
        throw new Error('database is locked');
      },
    };
    const broken = createPublicListener({
      config,
      log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
      now: () => clock,
      parentEnvironment: {},
      store: failing,
    });
    try {
      const response = await broken.fetch(
        new Request(`${PUBLIC}/oauth/register`, {
          body: JSON.stringify({ redirect_uris: [REDIRECT] }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('Internal Server Error');
      expect(lines).toEqual(['Answered POST /oauth/register with HTTP 500: database is locked']);
    } finally {
      await broken.close();
    }
  });

  test('does not count a refused registration', async () => {
    for (let index = 0; index < 10; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations count in order
      await register({ redirect_uris: ['http://example.com/cb'] });
    }

    expect((await register()).status).toBe(201);
  });
});

describe('the token endpoint, authorization_code grant', () => {
  test('exchanges an authorization code for tokens', async () => {
    const clientId = registeredClient();
    const { code } = approve(clientId);

    const response = await exchange(clientId, code);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Tokens;
    expect(body).toEqual({
      access_token: expect.stringMatching(/^mdg_at_/u),
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^mdg_rt_/u),
      token_type: 'Bearer',
    });
    expect(store.verifyAccessToken(body.access_token)?.resource).toBe(RESOURCE);
  });

  test('logs each issue with the client, the authorization, the grant, and whether resource was sent', async () => {
    const clientId = registeredClient();
    const { authorizationId, code } = approve(clientId);
    const prefix = authorizationId.slice(0, 8);
    const label = clientId.slice(0, 8);

    const exchanged = (await (await exchange(clientId, code)).json()) as Tokens;
    const refreshed = (await (await refresh(clientId, exchanged.refresh_token)).json()) as Tokens;
    await refresh(clientId, refreshed.refresh_token, { resource: RESOURCE });
    await refresh(clientId, 'mdg_rt_unknown');

    expect(lines).toEqual([
      `Issued tokens to client ${label} for authorization ${prefix} from the authorization code, resource absent.`,
      `Issued tokens to client ${label} for authorization ${prefix} from the refresh token, resource absent.`,
      `Issued tokens to client ${label} for authorization ${prefix} from the refresh token, resource sent.`,
    ]);
  });

  test('ignores client_assertion, client_assertion_type, and client_secret', async () => {
    const clientId = registeredClient();
    const { code } = approve(clientId);

    const response = await exchange(clientId, code, {
      client_assertion: 'eyJhbGciOiJub25lIn0.e30.',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_secret: 'whatever',
    });

    expect(response.status).toBe(200);
  });

  test('accepts a charset parameter on the form content type', async () => {
    const clientId = registeredClient();
    const { code } = approve(clientId);

    const response = await call('/oauth/token', {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: VERIFIER,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
  });

  test('accepts the resource when it matches, and refuses another with invalid_target', async () => {
    const clientId = registeredClient();
    const matching = approve(clientId);
    const other = approve(clientId);

    const accepted = await exchange(clientId, matching.code, { resource: RESOURCE });
    const refused = await exchange(clientId, other.code, { resource: `${PUBLIC}/other/mcp` });

    expect(accepted.status).toBe(200);
    expect(await errorOf(refused)).toBe('invalid_target');
  });

  test('requires the redirect_uri the authorization request carried, exactly', async () => {
    const clientId = registeredClient();
    const { code } = approve(clientId);

    const missing = await token({
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
    });
    const otherPort = await exchange(clientId, code, {
      redirect_uri: 'https://claude.ai:8443/api/mcp/auth_callback',
    });

    expect(await errorOf(missing)).toBe('invalid_grant');
    expect(await errorOf(otherPort)).toBe('invalid_grant');
    expect((await exchange(clientId, code)).status).toBe(200);
  });

  test('needs no redirect_uri when the authorization request carried none', async () => {
    const clientId = registeredClient();
    const { code } = approve(clientId, { requestedRedirectUri: null });

    const response = await token({
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
    });

    expect(response.status).toBe(200);
  });

  test('refuses a wrong code_verifier, an unknown code, and an expired code with invalid_grant', async () => {
    const clientId = registeredClient();
    const first = approve(clientId);
    const second = approve(clientId);

    const wrongVerifier = await exchange(clientId, first.code, { code_verifier: 'x'.repeat(43) });
    const unknown = await exchange(clientId, 'not-a-code');
    clock += 61_000;
    const expired = await exchange(clientId, second.code);

    expect(await errorOf(wrongVerifier)).toBe('invalid_grant');
    expect(await errorOf(unknown)).toBe('invalid_grant');
    expect(await errorOf(expired)).toBe('invalid_grant');
  });

  test("refuses another known client's code with invalid_grant", async () => {
    const owner = registeredClient();
    const other = registeredClient();
    const { code } = approve(owner);

    expect(await errorOf(await exchange(other, code))).toBe('invalid_grant');
  });

  test('refuses a client_id that names no client with invalid_client', async () => {
    const clientId = registeredClient();
    const { code } = approve(clientId);

    expect(await errorOf(await exchange('no-such-client', code))).toBe('invalid_client');
  });

  test('treats a client ID metadata URL as a client, so its refusals are invalid_grant', async () => {
    const { code } = approve(CIMD_CLIENT);

    expect(await errorOf(await exchange(CIMD_CLIENT, 'not-a-code'))).toBe('invalid_grant');
    expect((await exchange(CIMD_CLIENT, code)).status).toBe(200);
  });

  test('a spent code revokes its authorization, and the replay is logged by prefix only', async () => {
    const clientId = registeredClient();
    const { authorizationId, code } = approve(clientId);
    const tokens = (await (await exchange(clientId, code)).json()) as Tokens;

    const replay = await exchange(clientId, code);

    expect(await errorOf(replay)).toBe('invalid_grant');
    expect(store.verifyAccessToken(tokens.access_token)).toBeUndefined();
    expect(store.isAuthorizationActive(authorizationId)).toBe(false);
    const logged = lines.filter(
      (line) => line.includes(authorizationId.slice(0, 8)) && !line.startsWith('Issued tokens'),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('authorization code');
    expect(lines.some((line) => line.includes(authorizationId) || line.includes(code))).toBe(false);
  });
});

// Registers and approves a client, and exchanges its code for tokens.
const connect = async () => {
  const clientId = registeredClient();
  const { authorizationId, code } = approve(clientId);
  const tokens = (await (await exchange(clientId, code)).json()) as Tokens;
  return { authorizationId, clientId, tokens };
};

const refresh = (clientId: string, refreshToken: string, extra: Record<string, string> = {}) =>
  token({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...extra,
  });

describe('the token endpoint, refresh_token grant', () => {
  test('rotates the refresh token and issues a new access token', async () => {
    const { clientId, tokens } = await connect();

    const response = await refresh(clientId, tokens.refresh_token, { resource: RESOURCE });

    expect(response.status).toBe(200);
    const rotated = (await response.json()) as Tokens;
    expect(rotated.token_type).toBe('Bearer');
    expect(rotated.expires_in).toBe(3600);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.access_token).not.toBe(tokens.access_token);
  });

  test('a replayed refresh token revokes the authorization, and the replay is logged by prefix only', async () => {
    const { authorizationId, clientId, tokens } = await connect();
    const rotated = (await (await refresh(clientId, tokens.refresh_token)).json()) as Tokens;

    const replay = await refresh(clientId, tokens.refresh_token);

    expect(await errorOf(replay)).toBe('invalid_grant');
    expect(await errorOf(await refresh(clientId, rotated.refresh_token))).toBe('invalid_grant');
    const logged = lines.filter(
      (line) => line.includes(authorizationId.slice(0, 8)) && !line.startsWith('Issued tokens'),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('refresh token');
    const family = tokens.refresh_token.slice('mdg_rt_'.length, 'mdg_rt_'.length + 43);
    expect(lines.some((line) => line.includes(family))).toBe(false);
  });

  test('refuses a resource that does not match with invalid_target', async () => {
    const { clientId, tokens } = await connect();

    const response = await refresh(clientId, tokens.refresh_token, {
      resource: `${PUBLIC}/other/mcp`,
    });

    expect(await errorOf(response)).toBe('invalid_target');
  });

  test("refuses another client's refresh token with invalid_grant, and an unknown client with invalid_client", async () => {
    const { tokens } = await connect();

    const otherClient = await refresh(registeredClient(), tokens.refresh_token);
    const unknownClient = await refresh('no-such-client', tokens.refresh_token);

    expect(await errorOf(otherClient)).toBe('invalid_grant');
    expect(await errorOf(unknownClient)).toBe('invalid_client');
  });

  test('refuses a malformed refresh token with invalid_grant', async () => {
    const { clientId } = await connect();

    expect(await errorOf(await refresh(clientId, 'mdg_rt_short'))).toBe('invalid_grant');
  });
});

describe('the token endpoint, malformed requests', () => {
  test.each([
    ['no grant_type', {}],
    [
      'authorization_code without code',
      { client_id: 'c', code_verifier: VERIFIER, grant_type: 'authorization_code' },
    ],
    [
      'authorization_code without client_id',
      { code: 'x', code_verifier: VERIFIER, grant_type: 'authorization_code' },
    ],
    [
      'authorization_code without code_verifier',
      { client_id: 'c', code: 'x', grant_type: 'authorization_code' },
    ],
    [
      'a code_verifier under 43 characters',
      {
        client_id: 'c',
        code: 'x',
        code_verifier: 'a'.repeat(42),
        grant_type: 'authorization_code',
      },
    ],
    [
      'a code_verifier over 128 characters',
      {
        client_id: 'c',
        code: 'x',
        code_verifier: 'a'.repeat(129),
        grant_type: 'authorization_code',
      },
    ],
    [
      'a code_verifier outside the unreserved set',
      {
        client_id: 'c',
        code: 'x',
        code_verifier: `${'a'.repeat(42)}+`,
        grant_type: 'authorization_code',
      },
    ],
    ['refresh_token without refresh_token', { client_id: 'c', grant_type: 'refresh_token' }],
    ['refresh_token without client_id', { grant_type: 'refresh_token', refresh_token: 'x' }],
  ])('refuses %s with invalid_request', async (_, parameters) => {
    expect(await errorOf(await token(parameters))).toBe('invalid_request');
  });

  test('refuses a repeated parameter with invalid_request', async () => {
    const response = await call('/oauth/token', {
      body: 'grant_type=refresh_token&client_id=a&client_id=b&refresh_token=x',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });

    expect(await errorOf(response)).toBe('invalid_request');
  });

  test('refuses any other grant with unsupported_grant_type', async () => {
    const response = await token({ client_id: 'c', grant_type: 'client_credentials' });

    expect(await errorOf(response)).toBe('unsupported_grant_type');
  });

  test('takes form bodies only', async () => {
    const response = await call('/oauth/token', {
      body: JSON.stringify({ grant_type: 'refresh_token' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(await errorOf(response)).toBe('invalid_request');
  });

  test('refuses a body over 16 KiB', async () => {
    const response = await token({ grant_type: 'refresh_token', padding: 'x'.repeat(16 * 1024) });

    expect(await errorOf(response)).toBe('invalid_request');
  });
});
