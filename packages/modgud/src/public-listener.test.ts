import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import type { PublicListener } from './public-listener.ts';
import {
  connect,
  connectOAuthClient,
  createHarness,
  DAY,
  firstText,
  isAlive,
  post,
  rejectionOf,
  processesWith,
  PUBLIC,
  TOKEN,
  waitFor,
} from './testing/listener-harness.ts';

const harness = createHarness();
const { openTestStore, start } = harness;
beforeEach(harness.setup);
afterEach(harness.teardown);

describe('a Caller with the harness token', () => {
  test('lists and calls the Service tools, with definitions passed through unchanged', async () => {
    const { url } = await start();
    const { client } = await connect(url);

    const { tools } = await client.listTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'answer-despite-cancel',
      'child-request',
      'close-stdin',
      'crash',
      'echo',
      'environment',
      'exit',
      'list-changed',
      'log',
      'oversized',
      'pid',
      'progress',
      'progress-echo',
      'slow',
      'stderr',
      'unmatched-response',
      'wait-for-cancel',
    ]);
    expect(echo?.annotations).toEqual({ readOnlyHint: true });
    expect(echo?.inputSchema).toMatchObject({
      properties: { text: { type: 'string' } },
      required: ['text'],
    });

    const result = await client.callTool({ arguments: { text: 'hello' }, name: 'echo' });
    expect(firstText(result)).toBe('hello');
  });

  test("passes the Child's progress notification to the call it belongs to", async () => {
    const { url } = await start();
    const { client } = await connect(url);
    const progress: number[] = [];

    const result = await client.callTool(
      { arguments: {}, name: 'progress' },
      { onprogress: (update) => progress.push(update.progress) },
    );

    expect(firstText(result)).toBe('done');
    expect(progress).toEqual([1]);
  });

  test('falls back to initialize when the Caller probes for a later protocol revision', async () => {
    const { url } = await start();
    const { client } = await connect(url, { negotiation: 'auto' });

    const result = await client.callTool({ arguments: { text: 'fallback' }, name: 'echo' });

    expect(firstText(result)).toBe('fallback');
  });

  test("builds the Child's environment from the base variables and the Service's config only", async () => {
    const { url } = await start({
      parentEnvironment: { ...process.env, MODGUD_SECRET: 'must-not-leak' },
    });
    const { client } = await connect(url);

    const result = await client.callTool({ arguments: {}, name: 'environment' });
    const environment = JSON.parse(firstText(result) ?? '{}') as Record<string, string>;

    expect(environment.STUB_SETTING).toBe('configured');
    expect(environment).not.toHaveProperty('MODGUD_SECRET');
    expect(
      Object.keys(environment).filter(
        (name) =>
          ![
            'HOME',
            'LANG',
            'LC_ALL',
            'LOGNAME',
            'PATH',
            'STUB_MODE',
            'STUB_SETTING',
            'TMPDIR',
            'TZ',
            'USER',
          ].includes(name),
      ),
    ).toEqual([]);
  });

  test("keeps Modgud's own value of the Identity variable from the Child", async () => {
    const { url } = await start({
      identityEnv: 'USER',
      parentEnvironment: { ...process.env, USER: 'operator' },
    });
    const { client } = await connect(url);

    const result = await client.callTool({ arguments: {}, name: 'environment' });

    expect(JSON.parse(firstText(result) ?? '{}')).not.toHaveProperty('USER');
  });

  test("logs the Child's stderr, tagged with its Service and Grant", async () => {
    const { lines, store, url } = await start();
    const { authorizationId, accessToken } = connectOAuthClient(store);
    await connect(url);
    await connect(url, { token: accessToken });

    await waitFor(
      () => lines.filter((line) => line.endsWith('stderr: stub-service started')).length === 2,
    );
    expect(lines).toContainEqual('stub child for static-token stderr: stub-service started');
    expect(lines).toContainEqual(
      `stub child for authorization ${authorizationId.slice(0, 8)} stderr: stub-service started`,
    );
  });

  test("logs the Child's stderr escaped and cut to 2000 code points", async () => {
    const { lines, url } = await start();
    const { client } = await connect(url);

    await client.callTool({
      arguments: { text: `bell\u0007${'b'.repeat(3000)}` },
      name: 'stderr',
    });

    await waitFor(() => lines.some((line) => line.includes('stderr: bell')));
    expect(lines).toContainEqual(
      `stub child for static-token stderr: bell\\u0007${'b'.repeat(1995)}`,
    );
  });
});

describe('logging', () => {
  test('a Child response id with a newline stays on one log line', async () => {
    const { lines, url } = await start();
    const { client } = await connect(url);

    await client.callTool({ arguments: {}, name: 'unmatched-response' });

    await waitFor(() => lines.some((line) => line.includes('forged')));
    expect(lines.filter((line) => line.includes('\n'))).toEqual([]);
  });
});

describe('a Child that closes its stdin', () => {
  test('a Caller message it can no longer receive is logged, not left as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const { lines, url } = await start();
      const { client } = await connect(url);
      await client.callTool({ arguments: {}, name: 'close-stdin' });
      await Bun.sleep(100);

      // The Child never receives this call, so its answer is not awaited. A
      // message this large is written asynchronously, so its failure arrives
      // as a rejected promise rather than a thrown error.
      const lost = async () => {
        try {
          await client.callTool({ arguments: { text: 'x'.repeat(200_000) }, name: 'echo' });
        } catch {
          // The call times out or fails; only Modgud's handling matters here.
        }
      };
      void lost();
      await waitFor(() => lines.some((line) => line.includes('could not write to the Child')));
      await Bun.sleep(100);

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

describe('ending a Session', () => {
  test('DELETE ends the Session, and later requests on it get 404', async () => {
    const { listener, url } = await start();
    const { client, transport } = await connect(url);
    const sessionId = transport.sessionId ?? '';

    await transport.terminateSession();
    await waitFor(() => listener.sessionCount() === 0);

    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': sessionId,
    });
    expect(response.status).toBe(404);
    await client.close();
  });

  test('an idle Session is ended after its timeout, and later requests on it get 404', async () => {
    const { lines, listener, url } = await start({ sessionIdleMinutes: 0.005 });
    const { transport } = await connect(url);

    await waitFor(() => listener.sessionCount() === 0);
    expect(lines.some((line) => line.endsWith('ended: idle.'))).toBe(true);
    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': transport.sessionId ?? '',
    });
    expect(response.status).toBe(404);
  });

  test('a cancelled call the Child never answers does not keep the Child past its idle timeout', async () => {
    const { lines, listener, url } = await start({ idleMinutes: 0.005 });
    const { client } = await connect(url);

    let cancelled = false;
    try {
      await client.callTool({ arguments: {}, name: 'slow' }, { timeout: 100 });
    } catch {
      cancelled = true;
    }

    expect(cancelled).toBe(true);
    await waitFor(() =>
      lines.some((line) => line.endsWith('child for static-token stopped: idle.')),
    );
    expect(listener.sessionCount()).toBe(1);
  });

  test('an uncancelled call the Child never answers does not keep the Child past its idle timeout, and gets an error', async () => {
    const { lines, listener, url } = await start({ idleMinutes: 0.005 });
    const { client } = await connect(url);

    const call = client.callTool({ arguments: {}, name: 'slow' });

    expect(await rejectionOf(call)).toContain('The Service stopped before it answered');
    expect(lines.some((line) => line.endsWith('child for static-token stopped: idle.'))).toBe(true);
    expect(listener.sessionCount()).toBe(1);
  });

  test('a Child that never answers initialize is stopped within the bound, and the initialize gets 502', async () => {
    const marker = `marker-${crypto.randomUUID()}`;
    const { lines, listener, url } = await start({
      childLimits: { initializeTimeoutMs: 200 },
      marker,
      stubEnv: { STUB_MODE: 'mute' },
    });

    const response = await post(url, { Authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: -32_603, message: 'The Service could not be started' },
      id: null,
      jsonrpc: '2.0',
    });
    expect(listener.sessionCount()).toBe(0);
    expect(lines).toContainEqual('stub child for static-token stopped: initialize timed out.');
    await waitFor(async () => (await processesWith(marker)).length === 0);
  });

  test('a Child message over the size limit stops the Child and fails the call, and the Session survives', async () => {
    const { lines, listener, url } = await start({ childLimits: { backoffBaseMs: 50 } });
    const { client } = await connect(url);

    const call = client.callTool({ arguments: {}, name: 'oversized' });

    expect(await rejectionOf(call)).toContain('The Service stopped before it answered');
    expect(lines).toContainEqual('stub child for static-token stopped: unreadable output.');
    expect(listener.sessionCount()).toBe(1);
    await Bun.sleep(100);
    const result = await client.callTool({ arguments: { text: 'still here' }, name: 'echo' });
    expect(firstText(result)).toBe('still here');
  });

  test('an initialize after close gets 503 and starts no Child', async () => {
    const { listener, url } = await start();
    await listener.close();
    const spawn = spyOn(Bun, 'spawn');

    try {
      const response = await post(url, { Authorization: `Bearer ${TOKEN}` });

      expect(response.status).toBe(503);
      expect(listener.sessionCount()).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test('close does not resolve until a Session still opening is ended and its Child stopped', async () => {
    const spawn = spyOn(Bun, 'spawn');
    const race: {
      childAlive?: boolean;
      closed?: Promise<void> | undefined;
      listener?: PublicListener;
    } = {};
    // The listener reads the parent environment while it opens a Session, so
    // reading PATH starts close() in exactly that window. Whether the Child
    // is alive is read as soon as close() resolves, before Modgud could reap
    // a Child that close() did not wait for.
    const parentEnvironment = {
      ...process.env,
      get PATH() {
        queueMicrotask(() => {
          race.closed = (async () => {
            await race.listener?.close();
            race.childAlive = spawn.mock.results.some(({ value }) =>
              isAlive((value as Bun.Subprocess).pid),
            );
          })();
        });
        return process.env.PATH;
      },
    };

    try {
      const instance = await start({ parentEnvironment });
      race.listener = instance.listener;
      const { lines, url } = instance;

      const response = await post(url, { Authorization: `Bearer ${TOKEN}` });
      await race.closed;

      expect(race.closed).toBeDefined();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(race.childAlive).toBe(false);
      expect(response.status).toBe(503);
      expect(instance.listener.sessionCount()).toBe(0);
      expect(lines.some((line) => line.endsWith('ended: shutdown.'))).toBe(true);
    } finally {
      spawn.mockRestore();
    }
  });

  test('close does not resolve until a Child already stopping has exited', async () => {
    const { lines, listener, url } = await start({
      idleMinutes: 0.005,
      stubEnv: { STUB_MODE: 'ignore-sigterm' },
    });
    const { client } = await connect(url);
    const pid = Number(firstText(await client.callTool({ arguments: {}, name: 'pid' })));
    await waitFor(() => lines.some((line) => line.endsWith('stopped: idle.')));
    expect(isAlive(pid)).toBe(true);

    await listener.close();

    expect(isAlive(pid)).toBe(false);
  }, 10_000);
});

describe('refusals', () => {
  test("a request without a token gets 401 naming the Service's protected-resource metadata", async () => {
    const { listener, url } = await start();

    const response = await post(url, {});

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/stub/mcp"`,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(listener.sessionCount()).toBe(0);
  });

  test('a request with a wrong token gets 401 with invalid_token', async () => {
    const { url } = await start();

    const response = await post(url, { Authorization: 'Bearer wrong' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/stub/mcp", error="invalid_token"`,
    );
    let refused = false;
    try {
      await connect(url, { token: 'wrong' });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test('an unknown session id gets 404', async () => {
    const { url } = await start();

    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': crypto.randomUUID(),
    });

    expect(response.status).toBe(404);
  });

  test('an unknown Service path gets 404', async () => {
    const { url } = await start();

    const response = await post(new URL('/missing/mcp', url), {
      Authorization: `Bearer ${TOKEN}`,
    });

    expect(response.status).toBe(404);
  });

  test("the harness token gets 401 with invalid_token at another Service's path", async () => {
    const { listener, url } = await start();

    const response = await post(new URL('/other/mcp', url), { Authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/other/mcp", error="invalid_token"`,
    );
    expect(listener.sessionCount()).toBe(0);
  });

  test('a foreign Origin gets 403, and an allowed one passes', async () => {
    const { url } = await start({ origins: ['https://claude.ai'] });

    const foreign = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'https://evil.test',
    });
    const allowed = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'https://claude.ai',
    });

    expect(foreign.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  test('warns of a refused Origin only for a caller with a valid credential', async () => {
    const { lines, store, url } = await start({ origins: ['https://claude.ai'] });
    const { accessToken, authorizationId, clientId } = connectOAuthClient(store);
    const foreign = { Origin: 'https://evil.test' };

    await post(url, foreign);
    await post(url, { ...foreign, Authorization: 'Bearer wrong' });
    expect(lines).toEqual([]);
    const staticToken = await post(url, { ...foreign, Authorization: `Bearer ${TOKEN}` });
    const oauth = await post(url, { ...foreign, Authorization: `Bearer ${accessToken}` });

    expect(staticToken.status).toBe(403);
    expect(oauth.status).toBe(403);
    expect(lines).toEqual([
      'Refused a stub request from the static bearer token: Origin https://evil.test is not allowed.',
      `Refused a stub request from client ${clientId.slice(0, 8)} authorization ${authorizationId.slice(0, 8)}: Origin https://evil.test is not allowed.`,
    ]);
  });

  test('a refused Origin is logged escaped and cut to 200 code points', async () => {
    const { lines, url } = await start({ origins: ['https://claude.ai'] });
    const origin = `https://evil.test\u0085${'a'.repeat(300)}`;

    const response = await post(url, { Authorization: `Bearer ${TOKEN}`, Origin: origin });

    expect(response.status).toBe(403);
    expect(lines).toEqual([
      `Refused a stub request from the static bearer token: Origin https://evil.test\\u0085${'a'.repeat(182)} is not allowed.`,
    ]);
  });

  test('a request other than initialize without a session id gets 400 and starts no Child', async () => {
    const { listener, url } = await start();

    const response = await post(
      url,
      { Authorization: `Bearer ${TOKEN}` },
      JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
    );

    expect(response.status).toBe(400);
    expect(listener.sessionCount()).toBe(0);
  });
});

describe('a Caller with an OAuth access token', () => {
  test('lists and calls the Service tools, and its responses are not stored', async () => {
    const { store, url } = await start();
    const { accessToken } = connectOAuthClient(store);
    const { client } = await connect(url, { token: accessToken });

    const result = await client.callTool({ arguments: { text: 'oauth' }, name: 'echo' });
    const initialize = await post(url, { Authorization: `Bearer ${accessToken}` });

    expect(firstText(result)).toBe('oauth');
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('cache-control')).toBe('no-store');
    await initialize.body?.cancel();
  });

  test('logs which client opened a Session, with its Origin and requested protocol revision', async () => {
    const { lines, store, url } = await start({ origins: ['https://claude.ai'] });
    const { accessToken, authorizationId, clientId } = connectOAuthClient(store);

    const oauth = await post(url, {
      Authorization: `Bearer ${accessToken}`,
      Origin: 'https://claude.ai',
    });
    const staticToken = await post(url, { Authorization: `Bearer ${TOKEN}` });

    expect(oauth.status).toBe(200);
    expect(staticToken.status).toBe(200);
    const opened = lines.filter((line) => line.includes(' opened'));
    expect(opened).toEqual([
      expect.stringMatching(
        new RegExp(
          `^stub session \\w{8} opened for client ${clientId.slice(0, 8)} authorization ${authorizationId.slice(0, 8)}, Origin https://claude\\.ai, protocol 2025-11-25\\.$`,
          'u',
        ),
      ),
      expect.stringMatching(
        /^stub session \w{8} opened for the static bearer token, Origin none, protocol 2025-11-25\.$/u,
      ),
    ]);
    expect(lines.join('\n')).not.toContain(accessToken);
    await oauth.body?.cancel();
    await staticToken.body?.cancel();
  });

  test("gets 401 with invalid_token at another Service's path", async () => {
    const { listener, store, url } = await start();
    const { accessToken } = connectOAuthClient(store);

    const response = await post(new URL('/other/mcp', url), {
      Authorization: `Bearer ${accessToken}`,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/other/mcp", error="invalid_token"`,
    );
    expect(listener.sessionCount()).toBe(0);
  });

  test('gets 401 with invalid_token once its authorization is revoked', async () => {
    const { store, url } = await start();
    const { accessToken } = connectOAuthClient(store);
    store.revokeAll();

    const response = await post(url, { Authorization: `Bearer ${accessToken}` });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

// A tools/list request on the Session, with the given credential.
const listOn = (url: URL, sessionId: string, protocolVersion: string, token: string) =>
  post(
    url,
    {
      Authorization: `Bearer ${token}`,
      'Mcp-Protocol-Version': protocolVersion,
      'Mcp-Session-Id': sessionId,
    },
    JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/list' }),
  );

describe('a Session bound to its credential source', () => {
  test("gets 404 for another authorization's valid token and for the static token", async () => {
    const { store, url } = await start();
    const owner = connectOAuthClient(store);
    const other = connectOAuthClient(store);
    const { transport } = await connect(url, { token: owner.accessToken });
    const sessionId = transport.sessionId ?? '';
    const version = transport.protocolVersion ?? '';

    const otherAuthorization = await listOn(url, sessionId, version, other.accessToken);
    const staticToken = await listOn(url, sessionId, version, TOKEN);
    const sameAuthorization = await listOn(url, sessionId, version, owner.accessToken);

    expect(otherAuthorization.status).toBe(404);
    expect(staticToken.status).toBe(404);
    expect(sameAuthorization.status).toBe(200);
    await sameAuthorization.body?.cancel();
  });

  test('a static-token Session gets 404 for a valid OAuth access token', async () => {
    const { store, url } = await start();
    const { accessToken } = connectOAuthClient(store);
    const { transport } = await connect(url);

    const response = await listOn(
      url,
      transport.sessionId ?? '',
      transport.protocolVersion ?? '',
      accessToken,
    );

    expect(response.status).toBe(404);
  });

  test('accepts a newer access token of the same authorization after a refresh', async () => {
    const { store, url } = await start();
    const { accessToken, refreshToken } = connectOAuthClient(store);
    const { transport } = await connect(url, { token: accessToken });
    const clientId = store.verifyAccessToken(accessToken)?.clientId ?? '';
    const refreshed = store.refresh({ clientId, refreshToken });
    const newer = refreshed.ok ? refreshed.tokens.accessToken : '';

    const response = await listOn(
      url,
      transport.sessionId ?? '',
      transport.protocolVersion ?? '',
      newer,
    );

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});

describe('ending the Sessions of an authorization', () => {
  test('modgud revoke from another store handle ends its Sessions, streams, and Children within 10 seconds', async () => {
    const { lines, listener, store, url } = await start();
    const { accessToken } = connectOAuthClient(store);
    const staticSession = await connect(url);
    // A raw Session, so the test holds its only GET stream.
    const auth = { Authorization: `Bearer ${accessToken}` };
    const opened = await post(url, auth);
    const session = { ...auth, 'Mcp-Session-Id': opened.headers.get('mcp-session-id') ?? '' };
    await opened.text();
    const initialized = await post(
      url,
      session,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(initialized.status).toBe(202);
    const pidCall = await post(
      url,
      session,
      JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/call', params: { name: 'pid' } }),
    );
    const pid = Number(/"text":"(\d+)"/u.exec(await pidCall.text())?.[1]);
    // Bun sends an event stream's headers with its first event, and this
    // stream carries none, so its response arrives only once it closes.
    const stream = fetch(url, { headers: { Accept: 'text/event-stream', ...session } });
    await Bun.sleep(200);
    expect(listener.sessionCount()).toBe(2);
    expect(isAlive(pid)).toBe(true);

    const revokedAt = Date.now();
    const otherProcess = await openTestStore();
    expect(otherProcess.revokeAll()).toBe(1);

    await waitFor(() => listener.sessionCount() === 1, 10_000);
    expect(Date.now() - revokedAt).toBeLessThan(10_000);
    const closed = await stream;
    expect(closed.status).toBe(200);
    expect(await closed.text()).toBe('');
    await waitFor(() => !isAlive(pid));
    expect(lines.some((line) => line.endsWith('ended: authorization ended.'))).toBe(true);
    const staticResult = await staticSession.client.callTool({
      arguments: { text: 'still here' },
      name: 'echo',
    });
    expect(firstText(staticResult)).toBe('still here');
  }, 15_000);

  test('an expired authorization ends its Sessions', async () => {
    const { listener, store, url } = await start({ authorizationSweepMs: 20 });
    const { accessToken } = connectOAuthClient(store);
    await connect(url, { token: accessToken });
    await Bun.sleep(100);
    expect(listener.sessionCount()).toBe(1);

    harness.advanceClock(30 * DAY);

    await waitFor(() => listener.sessionCount() === 0);
  });
});

describe('store maintenance', () => {
  test('deletes expired rows on its interval, and stops once the listener closes', async () => {
    let cleanups = 0;
    const { listener } = await start({
      storeCleanupMs: 10,
      wrapStore: (store) => ({
        ...store,
        removeExpired: () => {
          cleanups += 1;
        },
      }),
    });

    await waitFor(() => cleanups >= 2);
    await listener.close();
    const afterClose = cleanups;
    await Bun.sleep(50);

    expect(cleanups).toBe(afterClose);
  });
});
