import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { sha256Hex } from './bearer.ts';
import { parseConfig } from './config.ts';
import type { Log } from './log.ts';
import { s256Challenge } from './pkce.ts';
import { createPublicListener } from './public-listener.ts';
import type { PublicListener } from './public-listener.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';

const TOKEN = 'harness-token';
const STUB = `${import.meta.dir}/testing/stub-service.ts`;
const PUBLIC = 'https://modgud.example.com';
const RESOURCE = `${PUBLIC}/stub/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const DAY = 24 * 60 * 60_000;

type Running = {
  listener: PublicListener;
  lines: string[];
  url: URL;
  stop: () => Promise<void>;
  store: Store;
};
const running: Running[] = [];
const stores: Store[] = [];
let directory = '';
// The store's clock, which decides when an authorization expires.
let clock = Date.now();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'modgud-listener-'));
  clock = Date.now();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (instance) => instance.stop()));
  for (const store of stores.splice(0)) {
    store.close();
  }
  await rm(directory, { force: true, recursive: true });
});

// Opens a handle on the test's store, as the server or another process does.
const openTestStore = async () => {
  const store = await openStore({
    maxTokenLifetimeDays: 30,
    now: () => clock,
    path: join(directory, 'modgud.sqlite'),
    resource: RESOURCE,
    warn: () => undefined,
  });
  stores.push(store);
  return store;
};

// Approves a new client for the harness Service and exchanges its code, as a
// chat client does through the Approval page and the token endpoint.
const connectOAuthClient = (store: Store) => {
  const { clientId } = store.registerClient({ redirectUris: [REDIRECT] });
  const { code: pairingCode } = store.mintPairingCode(10);
  const approved = store.approve({
    clientId,
    codeChallenge: s256Challenge(VERIFIER),
    pairingCode,
    redirectUri: REDIRECT,
    requestedRedirectUri: null,
  });
  const result = store.exchangeAuthorizationCode({
    clientId,
    code: approved?.code ?? '',
    codeVerifier: VERIFIER,
  });
  if (!result.ok) {
    throw new Error(`The exchange failed: ${result.error}`);
  }
  return result.tokens;
};

// Serves the stub Service as `stub`, the harness's Service, and again as
// `other`, on a free localhost port.
const start = async ({
  authorizationSweepMs = undefined as number | undefined,
  identityEnv = undefined as string | undefined,
  idleMinutes = 30,
  initializeTimeoutMs = undefined as number | undefined,
  marker = '',
  maxSessions = 16,
  origins = [] as string[],
  parentEnvironment = process.env,
  storeCleanupMs = undefined as number | undefined,
  stubMode = '',
  wrapStore = (store: Store) => store,
} = {}): Promise<Running> => {
  const stub = `
    command = ${JSON.stringify(process.execPath)}
    args = ${JSON.stringify([STUB, ...(marker === '' ? [] : [marker])])}
    env = { STUB_SETTING = "configured", STUB_MODE = ${JSON.stringify(stubMode)} }
    idle_timeout_minutes = ${String(idleMinutes)}
  `;
  const config = parseConfig(`
    [harness]
    bearer_token_sha256 = "${sha256Hex(TOKEN)}"
    service = "stub"

    [public]
    allowed_origins = ${JSON.stringify(origins)}
    max_sessions = ${String(maxSessions)}
    base_url = "${PUBLIC}"

    [admin]
    base_url = "https://modgud.example.ts.net"
    host = "100.64.0.1"

    [services.stub]
    ${stub}
    ${identityEnv === undefined ? '' : `identity_env = "${identityEnv}"`}

    [services.other]
    ${stub}
  `);
  const lines: string[] = [];
  const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const store = await openTestStore();
  const listener = createPublicListener({
    config,
    log,
    parentEnvironment,
    store: wrapStore(store),
    ...(authorizationSweepMs === undefined ? {} : { authorizationSweepMs }),
    ...(initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs }),
    ...(storeCleanupMs === undefined ? {} : { storeCleanupMs }),
  });
  const server = Bun.serve({
    fetch: listener.fetch,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    port: 0,
  });
  const instance: Running = {
    lines,
    listener,
    stop: async () => {
      await listener.close();
      await server.stop(true);
    },
    store,
    url: new URL('/stub/mcp', server.url),
  };
  running.push(instance);
  return instance;
};

// Command lines of the running processes that contain the marker.
const processesWith = async (marker: string) => {
  const ps = Bun.spawn(['ps', '-A', '-ww', '-o', 'args='], { stdout: 'pipe' });
  const output = await new Response(ps.stdout).text();
  return output.split('\n').filter((line) => line.includes(marker));
};

const connect = async (
  url: URL,
  {
    negotiation = 'legacy',
    token = TOKEN,
  }: { negotiation?: 'auto' | 'legacy'; token?: string } = {},
) => {
  const client = new Client(
    { name: 'test-caller', version: '1.0.0' },
    { capabilities: { roots: {} }, versionNegotiation: { mode: negotiation } },
  );
  client.setRequestHandler('roots/list', () => ({
    roots: [{ name: 'root', uri: 'file:///root' }],
  }));
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
};

const firstText = (result: Awaited<ReturnType<Client['callTool']>>) => {
  const [block] = result.content as { text: string }[];
  return block?.text;
};

const initializeBody = JSON.stringify({
  id: 1,
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
    protocolVersion: '2025-11-25',
  },
});

const post = (url: URL, headers: Record<string, string>, body = initializeBody) =>
  fetch(url, {
    body,
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });

// Whether a process with this id exists, counting one that has exited but has
// not yet been reaped.
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  // oxlint-disable-next-line no-await-in-loop -- polling waits on purpose
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling waits on purpose
    await Bun.sleep(10);
  }
};

describe('a Caller with the harness token', () => {
  test('lists and calls the Service tools, with definitions passed through unchanged', async () => {
    const { url } = await start();
    const { client } = await connect(url);

    const { tools } = await client.listTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'close-stdin',
      'echo',
      'environment',
      'exit',
      'notify-after-cancel',
      'oversized',
      'pid',
      'progress',
      'roots',
      'slow',
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

  test("passes the Child's request to the Caller and the Caller's answer back", async () => {
    const { url } = await start();
    const { client } = await connect(url);

    const result = await client.callTool({ arguments: {}, name: 'roots' });

    expect(JSON.parse(firstText(result) ?? '')).toEqual([{ name: 'root', uri: 'file:///root' }]);
  });

  test('falls back to initialize when the Caller probes for a later protocol revision', async () => {
    const { url } = await start();
    const { client } = await connect(url, { negotiation: 'auto' });

    const result = await client.callTool({ arguments: { text: 'fallback' }, name: 'echo' });

    expect(firstText(result)).toBe('fallback');
  });

  test('gives each Session its own Child', async () => {
    const { listener, url } = await start();
    const first = await connect(url);
    const second = await connect(url);

    const pids = await Promise.all(
      [first, second].map(async ({ client }) => {
        const result = await client.callTool({ arguments: {}, name: 'pid' });
        return firstText(result);
      }),
    );

    expect(listener.sessionCount()).toBe(2);
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    expect(pids[0]).toMatch(/^\d+$/u);
    expect(pids[0]).not.toBe(pids[1]);
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

  test("logs the Child's stderr, tagged with its Service and Session", async () => {
    const { lines, url } = await start();
    const { transport } = await connect(url);

    await waitFor(() => lines.some((line) => line.includes('stderr: stub-service started')));
    expect(lines).toContainEqual(
      `stub session ${transport.sessionId?.slice(0, 8) ?? ''} stderr: stub-service started`,
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

  test('a Child that exits ends its Session, and later requests on it get 404', async () => {
    const { lines, listener, url } = await start();
    const { client, transport } = await connect(url);

    await client.callTool({ arguments: {}, name: 'exit' });
    await waitFor(() => listener.sessionCount() === 0);

    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': transport.sessionId ?? '',
    });
    expect(response.status).toBe(404);
    expect(lines.some((line) => line.endsWith('ended: child exited.'))).toBe(true);
  });

  test('an idle Session is ended after its timeout', async () => {
    const { lines, listener, url } = await start({ idleMinutes: 0.005 });
    await connect(url);

    await waitFor(() => listener.sessionCount() === 0);
    expect(lines.some((line) => line.endsWith('ended: idle.'))).toBe(true);
  });

  test('a cancelled call the Child never answers does not keep its Session past the idle timeout', async () => {
    const { lines, listener, url } = await start({ idleMinutes: 0.005 });
    const { client } = await connect(url);

    let cancelled = false;
    try {
      await client.callTool({ arguments: {}, name: 'slow' }, { timeout: 100 });
    } catch {
      cancelled = true;
    }

    expect(cancelled).toBe(true);
    await waitFor(() => listener.sessionCount() === 0);
    expect(lines.some((line) => line.endsWith('ended: idle.'))).toBe(true);
  });

  test('an uncancelled call the Child never answers does not keep its Session past the idle timeout', async () => {
    const { lines, listener, url } = await start({ idleMinutes: 0.005 });
    const { client } = await connect(url);
    const abandon = new AbortController();
    const call = (async () => {
      try {
        await client.callTool({ arguments: {}, name: 'slow' }, { signal: abandon.signal });
      } catch {
        // Expected: the test abandons the call once its Session has ended.
      }
    })();

    await waitFor(() => listener.sessionCount() === 0);
    abandon.abort();
    await call;
    expect(lines.some((line) => line.endsWith('ended: idle.'))).toBe(true);
  });

  test("after the Caller cancels one call, the Child's notification without a progress token reaches the other call in flight", async () => {
    const { lines, url } = await start();
    const { transport } = await connect(url);
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Protocol-Version': transport.protocolVersion ?? '',
      'Mcp-Session-Id': transport.sessionId ?? '',
    };
    const callTool = (id: string, name: string) =>
      post(
        url,
        headers,
        JSON.stringify({
          id,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: {}, name },
        }),
      );

    // Bun sends an event stream's headers with its first event, so neither
    // call's response arrives until the Child writes to it. The cancelled
    // call's never does, so the test does not wait for it.
    void (async () => {
      try {
        await callTool('cancelled', 'wait-for-cancel');
      } catch {
        // Expected when the listener stops under the open stream.
      }
    })();
    await waitFor(() => lines.some((line) => line.endsWith('stderr: waiting for cancel')));
    const other = callTool('other', 'notify-after-cancel');
    await waitFor(() => lines.some((line) => line.endsWith('stderr: waiting to notify')));
    const cancel = await post(
      url,
      headers,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'cancelled' },
      }),
    );

    expect(cancel.status).toBe(202);
    const stream = await (await other).text();
    expect(stream).toContain('after cancel');
    expect(stream).toContain('notified');
  });

  test('a Child that never answers initialize is ended within the bound', async () => {
    const marker = `marker-${crypto.randomUUID()}`;
    const { lines, listener, url } = await start({
      initializeTimeoutMs: 200,
      marker,
      stubMode: 'mute',
    });

    const response = await post(url, { Authorization: `Bearer ${TOKEN}` });
    await response.body?.cancel();

    await waitFor(() => listener.sessionCount() === 0);
    expect(lines.some((line) => line.endsWith('ended: initialize timed out.'))).toBe(true);
    await waitFor(async () => (await processesWith(marker)).length === 0);
  });

  test('a Child message over the size limit ends its Session instead of wedging it', async () => {
    const { lines, listener, url } = await start();
    const { client } = await connect(url);

    // The SDK client waits out its own timeout once the Session is gone.
    const call = (async () => {
      try {
        await client.callTool({ arguments: {}, name: 'oversized' }, { timeout: 1000 });
      } catch {
        // Expected: the Session ended under the call.
      }
    })();

    await waitFor(() => listener.sessionCount() === 0);
    await call;
    expect(lines.some((line) => line.endsWith('ended: child protocol error.'))).toBe(true);
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

  test('close does not resolve until the Child of a Session already ending has stopped', async () => {
    const { listener, url } = await start({ idleMinutes: 0.005, stubMode: 'ignore-sigterm' });
    const { client } = await connect(url);
    const pid = Number(firstText(await client.callTool({ arguments: {}, name: 'pid' })));
    await waitFor(() => listener.sessionCount() === 0);
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

  test('a new Session past the maximum gets 503', async () => {
    const { url } = await start({ maxSessions: 1 });
    await connect(url);

    const response = await post(url, { Authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(503);
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

    clock += 30 * DAY;

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
