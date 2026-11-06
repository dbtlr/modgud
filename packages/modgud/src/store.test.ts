import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { s256Challenge } from './pkce.ts';
import { openStore } from './store.ts';
import type { Store, StoreOptions } from './store.ts';

const RESOURCE = 'https://modgud.example.com/norn/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const START = Date.parse('2026-11-06T12:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ACCESS_TOKEN = /^mdg_at_[A-Za-z0-9_-]{43}$/u;
const REFRESH_TOKEN = /^mdg_rt_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u;

let directory = '';
let clock = START;
const stores: Store[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'modgud-store-'));
  clock = START;
});

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await rm(directory, { force: true, recursive: true });
});

const open = async (options: Partial<StoreOptions> = {}) => {
  const store = await openStore({
    maxTokenLifetimeDays: 30,
    now: () => clock,
    path: join(directory, 'modgud.sqlite'),
    resource: RESOURCE,
    warn: () => undefined,
    ...options,
  });
  stores.push(store);
  return store;
};

// Registers a client, failing the test when the store refuses it.
const register = (store: Store) => {
  const client = store.registerClient({ redirectUris: [REDIRECT] });
  if (client === undefined) {
    throw new Error('The registration was refused.');
  }
  return client;
};

// Registers a client, mints a Pairing code, and approves the client with it.
const approveClient = (
  store: Store,
  { requestedRedirectUri = REDIRECT }: { requestedRedirectUri?: string | null } = {},
) => {
  const { clientId } = register(store);
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
  return { ...approved, clientId };
};

// Approves a client and exchanges its authorization code for tokens.
const connectClient = (store: Store) => {
  const approved = approveClient(store);
  const result = store.exchangeAuthorizationCode({
    clientId: approved.clientId,
    code: approved.code,
    codeVerifier: VERIFIER,
    redirectUri: REDIRECT,
  });
  if (!result.ok) {
    throw new Error(`The exchange failed: ${result.error}`);
  }
  return { ...approved, ...result.tokens };
};

// Runs testing/store-race.ts in `racers` processes at once against the
// store, all starting the operation in the same millisecond, and returns what
// each printed.
const race = async (racers: number, operation: string[]) => {
  const startAt = String(Date.now() + 500);
  const processes = Array.from({ length: racers }, () =>
    Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/testing/store-race.ts`,
        join(directory, 'modgud.sqlite'),
        startAt,
        ...operation,
      ],
      { stderr: 'inherit', stdout: 'pipe' },
    ),
  );
  return Promise.all(
    processes.map(async (racer) => (await new Response(racer.stdout).text()).trim()),
  );
};

// An approval of the client with the Pairing code, for the redirect URI it requested.
const approval = (clientId: string, pairingCode: string) => ({
  clientId,
  codeChallenge: s256Challenge(VERIFIER),
  pairingCode,
  redirectUri: REDIRECT,
  requestedRedirectUri: REDIRECT,
});

describe('client registrations', async () => {
  test('registers a client and finds it by its identifier', async () => {
    const store = await open();

    const client = store.registerClient({ clientName: 'Claude', redirectUris: [REDIRECT] });
    if (client === undefined) {
      throw new Error('The registration was refused.');
    }

    expect(client.clientId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(client.clientIdIssuedAt).toBe(START / SECOND);
    expect(store.findClient(client.clientId)).toEqual(client);
    expect(store.findClient('unknown')).toBeUndefined();
  });

  test('leaves out an absent client name', async () => {
    const store = await open();
    const client = register(store);
    expect(store.findClient(client.clientId)).toEqual({
      clientId: client.clientId,
      clientIdIssuedAt: START / SECOND,
      redirectUris: [REDIRECT],
    });
  });

  test('forgets a registration never approved after 1 hour', async () => {
    const store = await open();
    const client = register(store);

    clock += HOUR - 1;
    expect(store.findClient(client.clientId)).toBeDefined();
    clock += 1;
    expect(store.findClient(client.clientId)).toBeUndefined();
    store.removeExpired();
    expect(store.findClient(client.clientId)).toBeUndefined();
  });

  test('keeps an approved registration after 1 hour and after its authorization is revoked', async () => {
    const store = await open();
    const { clientId } = approveClient(store);

    clock += 2 * HOUR;
    store.removeExpired();
    store.revokeAll();

    expect(store.findClient(clientId)).toBeDefined();
  });

  test('past 500 registrations, evicts the oldest one never approved', async () => {
    const store = await open();
    const { clientId: approved } = approveClient(store);
    const first = register(store);
    clock += 1;
    const second = register(store);
    for (let index = 0; index < 497; index += 1) {
      register(store);
    }
    expect(store.findClient(first.clientId)).toBeDefined();

    const newest = register(store);

    expect(store.findClient(first.clientId)).toBeUndefined();
    expect(store.findClient(second.clientId)).toBeDefined();
    expect(store.findClient(approved)).toBeDefined();
    expect(store.findClient(newest.clientId)).toBeDefined();
  });

  test('past the cap, evicts a registration with no live authorization, never-approved ones first', async () => {
    const store = await open({ storedClients: 3 });
    const revoked = approveClient(store);
    store.revokeAll();
    clock += 1;
    const live = approveClient(store);
    clock += 1;
    const neverApproved = register(store);
    clock += 1;

    const fourth = register(store);

    expect(store.findClient(neverApproved.clientId)).toBeUndefined();
    expect(store.findClient(revoked.clientId)).toBeDefined();
    expect(store.approve(approval(fourth.clientId, store.mintPairingCode(10).code))).toBeDefined();

    const fifth = register(store);

    expect(store.findClient(revoked.clientId)).toBeUndefined();
    expect(store.findClient(live.clientId)).toBeDefined();
    expect(store.findClient(fourth.clientId)).toBeDefined();
    expect(store.findClient(fifth.clientId)).toBeDefined();
  });

  test('past the cap, evicts an approved registration whose authorization expired', async () => {
    const store = await open({ maxTokenLifetimeDays: 1, storedClients: 2 });
    const expired = approveClient(store);
    clock += DAY;
    const live = approveClient(store);

    const newest = register(store);

    expect(store.findClient(expired.clientId)).toBeUndefined();
    expect(store.findClient(live.clientId)).toBeDefined();
    expect(store.findClient(newest.clientId)).toBeDefined();
  });

  test('stores nothing when every stored registration has a live authorization', async () => {
    const store = await open({ storedClients: 2 });
    const first = approveClient(store);
    const second = approveClient(store);

    expect(store.registerClient({ redirectUris: [REDIRECT] })).toBeUndefined();

    expect(store.findClient(first.clientId)).toBeDefined();
    expect(store.findClient(second.clientId)).toBeDefined();
    store.revokeAll();
    expect(store.registerClient({ redirectUris: [REDIRECT] })).toBeDefined();
  });
});

describe('Pairing codes', async () => {
  test('mints a code shown as XXXX-XXXX that expires after the given minutes', async () => {
    const store = await open();

    const minted = store.mintPairingCode(10);

    expect(minted.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
    expect(minted.expiresAt).toEqual(new Date(START + 10 * MINUTE));
  });

  test('approves with the code however it was typed', async () => {
    const store = await open();
    const { clientId } = register(store);
    const { code } = store.mintPairingCode(10);
    const typed = code.toLowerCase().replace('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l');

    const approved = store.approve({
      clientId,
      codeChallenge: s256Challenge(VERIFIER),
      pairingCode: typed,
      redirectUri: REDIRECT,
      requestedRedirectUri: null,
    });

    expect(approved?.code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(approved?.authorizationId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('approves exactly one authorization per code', async () => {
    const store = await open();
    const { clientId } = register(store);
    const { code } = store.mintPairingCode(10);

    expect(store.approve(approval(clientId, code))).toBeDefined();
    expect(store.approve(approval(clientId, code))).toBeUndefined();
  });

  test('refuses a code once it expires', async () => {
    const store = await open();
    const { clientId } = register(store);
    const { code } = store.mintPairingCode(1);

    clock += MINUTE;

    expect(store.approve(approval(clientId, code))).toBeUndefined();
  });

  test('refuses a wrong or malformed code without spending the real one', async () => {
    const store = await open();
    const { clientId } = register(store);
    const { code } = store.mintPairingCode(10);
    const wrong = code.startsWith('Z') ? `Y${code.slice(1)}` : `Z${code.slice(1)}`;

    expect(store.approve(approval(clientId, wrong))).toBeUndefined();
    expect(store.approve(approval(clientId, 'not a code'))).toBeUndefined();
    expect(store.approve(approval(clientId, code))).toBeDefined();
  });

  test('a code minted by one opening of the store works in another, as after `modgud pair`', async () => {
    const { code } = (await open()).mintPairingCode(10);
    const server = await open();
    const { clientId } = register(server);

    expect(server.approve(approval(clientId, code))).toBeDefined();
  });

  test('concurrent approvals from separate processes spend one code once', async () => {
    const store = await open();
    const { clientId } = register(store);
    const { code } = store.mintPairingCode(10);

    const outcomes = await race(6, ['approve', clientId, code]);

    expect(outcomes.filter((outcome) => outcome === 'approved')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(5);
    expect(store.revokeAll()).toBe(1);
  }, 20_000);
});

describe('authorization codes', async () => {
  test('exchanges once for an access token and a refresh token', async () => {
    const store = await open();
    const approved = approveClient(store);

    const result = store.exchangeAuthorizationCode({
      clientId: approved.clientId,
      code: approved.code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });

    expect(result).toEqual({
      ok: true,
      tokens: {
        accessToken: expect.stringMatching(ACCESS_TOKEN),
        authorizationId: approved.authorizationId,
        expiresIn: 3600,
        refreshToken: expect.stringMatching(REFRESH_TOKEN),
      },
    });
    if (result.ok) {
      expect(store.verifyAccessToken(result.tokens.accessToken)).toEqual({
        authorizationId: approved.authorizationId,
        clientId: approved.clientId,
        resource: RESOURCE,
      });
    }
  });

  test('a spent code presented again revokes its authorization and every token from it', async () => {
    const store = await open();
    const connected = connectClient(store);

    const replay = store.exchangeAuthorizationCode({
      clientId: connected.clientId,
      code: connected.code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });

    expect(replay).toEqual({
      error: 'invalid_grant',
      ok: false,
      revokedAuthorizationId: connected.authorizationId,
    });
    expect(store.verifyAccessToken(connected.accessToken)).toBeUndefined();
    expect(store.isAuthorizationActive(connected.authorizationId)).toBe(false);
    expect(
      store.refresh({ clientId: connected.clientId, refreshToken: connected.refreshToken }),
    ).toEqual({ error: 'invalid_grant', ok: false });
  });

  test('refuses a code after 60 seconds', async () => {
    const store = await open();
    const approved = approveClient(store);

    clock += 60 * SECOND;

    expect(
      store.exchangeAuthorizationCode({
        clientId: approved.clientId,
        code: approved.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT,
      }),
    ).toEqual({ error: 'invalid_grant', ok: false });
  });

  test('refuses an unknown code, another client, a wrong verifier, or a wrong redirect URI, without spending the code', async () => {
    const store = await open();
    const approved = approveClient(store);
    const exchange = (overrides: Partial<Parameters<Store['exchangeAuthorizationCode']>[0]>) =>
      store.exchangeAuthorizationCode({
        clientId: approved.clientId,
        code: approved.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT,
        ...overrides,
      });
    const refused = { error: 'invalid_grant', ok: false } as const;

    expect(exchange({ code: 'unknown' })).toEqual(refused);
    expect(exchange({ clientId: 'another-client' })).toEqual(refused);
    expect(exchange({ codeVerifier: 'a'.repeat(43) })).toEqual(refused);
    expect(exchange({ redirectUri: undefined })).toEqual(refused);
    expect(exchange({ redirectUri: `${REDIRECT}/` })).toEqual(refused);
    expect(exchange({ resource: 'https://modgud.example.com/other/mcp' })).toEqual({
      error: 'invalid_target',
      ok: false,
    });
    expect(exchange({ resource: RESOURCE }).ok).toBe(true);
  });

  test('needs no redirect URI when the authorization request carried none', async () => {
    const store = await open();
    const approved = approveClient(store, { requestedRedirectUri: null });

    const result = store.exchangeAuthorizationCode({
      clientId: approved.clientId,
      code: approved.code,
      codeVerifier: VERIFIER,
    });

    expect(result.ok).toBe(true);
  });
});

describe('across processes', async () => {
  test('processes opening a new store at once all open it', async () => {
    const outcomes = await race(4, ['open']);

    expect(outcomes).toEqual(['opened', 'opened', 'opened', 'opened']);
    const store = await open();
    expect(store.registerClient({ redirectUris: [REDIRECT] })).toBeDefined();
  }, 20_000);

  test('concurrent exchanges of one authorization code issue tokens once', async () => {
    const store = await open({ now: Date.now });
    const { clientId, code } = approveClient(store, { requestedRedirectUri: null });

    const outcomes = await race(4, ['exchange', clientId, code]);

    expect(outcomes.filter((outcome) => outcome === 'issued')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'invalid_grant')).toHaveLength(3);
  }, 20_000);

  test('concurrent refreshes with one refresh token rotate it once', async () => {
    const store = await open({ now: Date.now });
    const { clientId, refreshToken } = connectClient(store);

    const outcomes = await race(4, ['refresh', clientId, refreshToken]);

    expect(outcomes.filter((outcome) => outcome === 'issued')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'invalid_grant')).toHaveLength(3);
  }, 20_000);
});

describe('refresh tokens', async () => {
  test('rotate on every use, and the presented one stops working', async () => {
    const store = await open();
    const connected = connectClient(store);

    const first = store.refresh({
      clientId: connected.clientId,
      refreshToken: connected.refreshToken,
    });

    expect(first).toEqual({
      ok: true,
      tokens: {
        accessToken: expect.stringMatching(ACCESS_TOKEN),
        authorizationId: connected.authorizationId,
        expiresIn: 3600,
        refreshToken: expect.stringMatching(REFRESH_TOKEN),
      },
    });
    if (!first.ok) {
      return;
    }
    expect(first.tokens.refreshToken).not.toBe(connected.refreshToken);
    // The family part names the authorization in every token it issues.
    expect(first.tokens.refreshToken.slice(0, 51)).toBe(connected.refreshToken.slice(0, 51));
    const second = store.refresh({
      clientId: connected.clientId,
      refreshToken: first.tokens.refreshToken,
    });
    expect(second.ok).toBe(true);
  });

  test('a replayed refresh token revokes the authorization with every token from it', async () => {
    const store = await open();
    const connected = connectClient(store);
    const rotated = store.refresh({
      clientId: connected.clientId,
      refreshToken: connected.refreshToken,
    });

    const replay = store.refresh({
      clientId: connected.clientId,
      refreshToken: connected.refreshToken,
    });

    expect(replay).toEqual({
      error: 'invalid_grant',
      ok: false,
      revokedAuthorizationId: connected.authorizationId,
    });
    expect(store.isAuthorizationActive(connected.authorizationId)).toBe(false);
    expect(store.verifyAccessToken(connected.accessToken)).toBeUndefined();
    if (rotated.ok) {
      expect(store.verifyAccessToken(rotated.tokens.accessToken)).toBeUndefined();
      expect(
        store.refresh({ clientId: connected.clientId, refreshToken: rotated.tokens.refreshToken }),
      ).toEqual({ error: 'invalid_grant', ok: false });
    }
  });

  test('a family token presented with another client_id is refused without revoking', async () => {
    const store = await open();
    const connected = connectClient(store);

    expect(
      store.refresh({ clientId: 'another-client', refreshToken: connected.refreshToken }),
    ).toEqual({ error: 'invalid_grant', ok: false });
    const forgedSecret = `${connected.refreshToken.slice(0, 51)}${'A'.repeat(43)}`;
    expect(store.refresh({ clientId: 'another-client', refreshToken: forgedSecret })).toEqual({
      error: 'invalid_grant',
      ok: false,
    });

    expect(store.isAuthorizationActive(connected.authorizationId)).toBe(true);
    expect(
      store.refresh({ clientId: connected.clientId, refreshToken: connected.refreshToken }).ok,
    ).toBe(true);
  });

  test('a token of any other shape, or of an unknown family, is unknown', async () => {
    const store = await open();
    const connected = connectClient(store);
    const refused = { error: 'invalid_grant', ok: false } as const;

    for (const refreshToken of [
      '',
      connected.refreshToken.slice(1),
      `${connected.refreshToken}A`,
      connected.refreshToken.replace('.', '_'),
      `mdg_rt_${'A'.repeat(43)}.${'A'.repeat(43)}`,
    ]) {
      expect(store.refresh({ clientId: connected.clientId, refreshToken })).toEqual(refused);
    }
    expect(store.isAuthorizationActive(connected.authorizationId)).toBe(true);
  });

  test('refuses another resource without rotating', async () => {
    const store = await open();
    const connected = connectClient(store);

    expect(
      store.refresh({
        clientId: connected.clientId,
        refreshToken: connected.refreshToken,
        resource: 'https://modgud.example.com/other/mcp',
      }),
    ).toEqual({ error: 'invalid_target', ok: false });
    expect(
      store.refresh({
        clientId: connected.clientId,
        refreshToken: connected.refreshToken,
        resource: RESOURCE,
      }).ok,
    ).toBe(true);
  });
});

describe('access tokens and authorizations', async () => {
  test('an access token lasts 1 hour', async () => {
    const store = await open();
    const connected = connectClient(store);

    clock += HOUR - 1;
    expect(store.verifyAccessToken(connected.accessToken)).toBeDefined();
    clock += 1;
    expect(store.verifyAccessToken(connected.accessToken)).toBeUndefined();
  });

  test('refuses a token without the prefix or never issued', async () => {
    const store = await open();
    const connected = connectClient(store);

    expect(store.verifyAccessToken(connected.accessToken.slice(7))).toBeUndefined();
    expect(store.verifyAccessToken(`mdg_at_${'A'.repeat(43)}`)).toBeUndefined();
  });

  test('an authorization keeps only its 5 newest access tokens', async () => {
    const store = await open();
    const connected = connectClient(store);
    const accessTokens = [connected.accessToken];
    let refreshToken = connected.refreshToken;
    for (let index = 0; index < 5; index += 1) {
      const result = store.refresh({ clientId: connected.clientId, refreshToken });
      if (!result.ok) {
        throw new Error('The refresh failed.');
      }
      accessTokens.push(result.tokens.accessToken);
      refreshToken = result.tokens.refreshToken;
    }

    expect(store.verifyAccessToken(accessTokens[0] ?? '')).toBeUndefined();
    for (const accessToken of accessTokens.slice(1)) {
      expect(store.verifyAccessToken(accessToken)).toBeDefined();
    }
  });

  test('every token expires no later than its authorization', async () => {
    const store = await open({ maxTokenLifetimeDays: 1 });
    const connected = connectClient(store);
    clock = START + DAY - 30 * MINUTE;

    const late = store.refresh({
      clientId: connected.clientId,
      refreshToken: connected.refreshToken,
    });

    expect(late.ok && late.tokens.expiresIn).toBe(30 * 60);
    clock = START + DAY;
    expect(late.ok && store.verifyAccessToken(late.tokens.accessToken)).toBeUndefined();
    expect(store.isAuthorizationActive(connected.authorizationId)).toBe(false);
    expect(
      late.ok &&
        store.refresh({ clientId: connected.clientId, refreshToken: late.tokens.refreshToken }),
    ).toEqual({
      error: 'invalid_grant',
      ok: false,
    });
  });

  test('an authorization expires by the lifetime configured now, not at approval', async () => {
    const connected = connectClient(await open({ maxTokenLifetimeDays: 30 }));
    clock = START + 2 * DAY;

    const shortened = await open({ maxTokenLifetimeDays: 1 });
    expect(shortened.isAuthorizationActive(connected.authorizationId)).toBe(false);
    expect(
      shortened.refresh({ clientId: connected.clientId, refreshToken: connected.refreshToken }),
    ).toEqual({ error: 'invalid_grant', ok: false });

    const restored = await open({ maxTokenLifetimeDays: 30 });
    expect(restored.isAuthorizationActive(connected.authorizationId)).toBe(true);
  });

  test('an authorization for a resource that is no longer the harness Service is not valid', async () => {
    const connected = connectClient(await open());

    const moved = await open({ resource: 'https://modgud.example.com/other/mcp' });

    expect(moved.isAuthorizationActive(connected.authorizationId)).toBe(false);
    expect(moved.verifyAccessToken(connected.accessToken)).toBeUndefined();
    expect(
      moved.refresh({ clientId: connected.clientId, refreshToken: connected.refreshToken }),
    ).toEqual({ error: 'invalid_grant', ok: false });
  });

  test('pairing a second client leaves the first connected', async () => {
    const store = await open();
    const first = connectClient(store);
    const second = connectClient(store);

    expect(store.verifyAccessToken(first.accessToken)?.authorizationId).toBe(first.authorizationId);
    expect(store.verifyAccessToken(second.accessToken)?.authorizationId).toBe(
      second.authorizationId,
    );
  });

  test('everything survives closing and reopening the store', async () => {
    const before = await open();
    const connected = connectClient(before);
    const { code } = before.mintPairingCode(10);
    before.close();

    const after = await open();

    expect(after.findClient(connected.clientId)).toBeDefined();
    expect(after.verifyAccessToken(connected.accessToken)?.clientId).toBe(connected.clientId);
    expect(
      after.refresh({ clientId: connected.clientId, refreshToken: connected.refreshToken }).ok,
    ).toBe(true);
    expect(
      after.approve({
        clientId: connected.clientId,
        codeChallenge: s256Challenge(VERIFIER),
        pairingCode: code,
        redirectUri: REDIRECT,
        requestedRedirectUri: null,
      }),
    ).toBeDefined();
  });
});

describe('revokeAll', async () => {
  test('revokes every authorization and unspent Pairing code, keeping registrations', async () => {
    const store = await open();
    const first = connectClient(store);
    const second = approveClient(store);
    const { code } = store.mintPairingCode(10);

    expect(store.revokeAll()).toBe(2);

    expect(store.verifyAccessToken(first.accessToken)).toBeUndefined();
    expect(store.refresh({ clientId: first.clientId, refreshToken: first.refreshToken })).toEqual({
      error: 'invalid_grant',
      ok: false,
    });
    expect(
      store.exchangeAuthorizationCode({
        clientId: second.clientId,
        code: second.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT,
      }),
    ).toEqual({ error: 'invalid_grant', ok: false });
    expect(
      store.approve({
        clientId: first.clientId,
        codeChallenge: s256Challenge(VERIFIER),
        pairingCode: code,
        redirectUri: REDIRECT,
        requestedRedirectUri: null,
      }),
    ).toBeUndefined();
    expect(store.findClient(first.clientId)).toBeDefined();
    expect(store.findClient(second.clientId)).toBeDefined();
    expect(store.revokeAll()).toBe(0);
  });
});

describe('removeExpired', async () => {
  test('keeps a spent authorization code, so a replay after it expired still revokes', async () => {
    const store = await open();
    const connected = connectClient(store);
    clock += 2 * MINUTE;
    store.removeExpired();

    const replay = store.exchangeAuthorizationCode({
      clientId: connected.clientId,
      code: connected.code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });

    expect(replay).toEqual({
      error: 'invalid_grant',
      ok: false,
      revokedAuthorizationId: connected.authorizationId,
    });
    expect(store.isAuthorizationActive(connected.authorizationId)).toBe(false);
  });

  test('deletes expired authorizations and keeps current ones', async () => {
    const store = await open({ maxTokenLifetimeDays: 1 });
    connectClient(store);
    clock += 12 * HOUR;
    connectClient(store);
    clock = START + DAY;

    store.removeExpired();

    expect(store.revokeAll()).toBe(1);
  });
});

describe('the store file', async () => {
  test('holds no Pairing code, authorization code, or token in plaintext', async () => {
    const store = await open();
    const { code: pairingCode } = store.mintPairingCode(10);
    const connected = connectClient(store);
    const refreshed = store.refresh({
      clientId: connected.clientId,
      refreshToken: connected.refreshToken,
    });
    if (!refreshed.ok) {
      throw new Error(`The refresh failed: ${refreshed.error}`);
    }
    const secrets = [
      pairingCode,
      pairingCode.replace('-', ''),
      connected.code,
      connected.accessToken,
      connected.refreshToken,
      refreshed.tokens.accessToken,
      refreshed.tokens.refreshToken,
      // The secret part of each refresh token, after its family.
      ...[connected.refreshToken, refreshed.tokens.refreshToken].map(
        (token) => token.split('.')[1] ?? token,
      ),
    ];

    const db = new Database(join(directory, 'modgud.sqlite'), { readonly: true });
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const contents = JSON.stringify(
      tables.map(({ name }) => db.query(`SELECT * FROM "${name}"`).all()),
    );
    db.close();

    expect(tables.length).toBeGreaterThan(0);
    expect(contents).toContain(connected.clientId);
    for (const secret of secrets) {
      expect(contents).not.toContain(secret);
    }
  });

  test('is created with mode 0600 in a directory of mode 0700, as are its -wal and -shm files', async () => {
    const path = join(directory, 'state', 'modgud.sqlite');
    (await open({ path })).mintPairingCode(10);

    const modes = await Promise.all(
      [path, `${path}-wal`, `${path}-shm`].map(async (file) => (await stat(file)).mode & 0o777),
    );
    expect(modes).toEqual([0o600, 0o600, 0o600]);
    expect((await stat(join(directory, 'state'))).mode & 0o777).toBe(0o700);
  });
});
