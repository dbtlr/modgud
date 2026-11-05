import { afterEach, describe, expect, test } from 'bun:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { sha256Hex } from './bearer.ts';
import { parseConfig } from './config.ts';
import type { Log } from './log.ts';
import { createPublicListener } from './public-listener.ts';
import type { PublicListener } from './public-listener.ts';

const TOKEN = 'harness-token';
const STUB = `${import.meta.dir}/testing/stub-service.ts`;

type Running = { listener: PublicListener; lines: string[]; url: URL; stop: () => Promise<void> };
const running: Running[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (instance) => instance.stop()));
});

// Serves the stub Service as `stub` on a free localhost port.
const start = ({
  identityEnv = undefined as string | undefined,
  idleMinutes = 30,
  maxSessions = 16,
  origins = [] as string[],
  parentEnvironment = process.env,
} = {}): Running => {
  const config = parseConfig(`
    [harness]
    bearer_token_sha256 = "${sha256Hex(TOKEN)}"

    [public]
    allowed_origins = ${JSON.stringify(origins)}
    max_sessions = ${String(maxSessions)}

    [services.stub]
    command = ${JSON.stringify(process.execPath)}
    args = [${JSON.stringify(STUB)}]
    env = { STUB_SETTING = "configured" }
    idle_timeout_minutes = ${String(idleMinutes)}
    ${identityEnv === undefined ? '' : `identity_env = "${identityEnv}"`}
  `);
  const lines: string[] = [];
  const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const listener = createPublicListener({ config, log, parentEnvironment });
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
    url: new URL('/stub/mcp', server.url),
  };
  running.push(instance);
  return instance;
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

const waitFor = async (condition: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling waits on purpose
    await Bun.sleep(10);
  }
};

describe('a Caller with the harness token', () => {
  test('lists and calls the Service tools, with definitions passed through unchanged', async () => {
    const { url } = start();
    const { client } = await connect(url);

    const { tools } = await client.listTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'echo',
      'environment',
      'exit',
      'pid',
      'progress',
      'roots',
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
    const { url } = start();
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
    const { url } = start();
    const { client } = await connect(url);

    const result = await client.callTool({ arguments: {}, name: 'roots' });

    expect(JSON.parse(firstText(result) ?? '')).toEqual([{ name: 'root', uri: 'file:///root' }]);
  });

  test('falls back to initialize when the Caller probes for a later protocol revision', async () => {
    const { url } = start();
    const { client } = await connect(url, { negotiation: 'auto' });

    const result = await client.callTool({ arguments: { text: 'fallback' }, name: 'echo' });

    expect(firstText(result)).toBe('fallback');
  });

  test('gives each Session its own Child', async () => {
    const { listener, url } = start();
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
    const { url } = start({
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
            'STUB_SETTING',
            'TMPDIR',
            'TZ',
            'USER',
          ].includes(name),
      ),
    ).toEqual([]);
  });

  test("keeps Modgud's own value of the Identity variable from the Child", async () => {
    const { url } = start({
      identityEnv: 'USER',
      parentEnvironment: { ...process.env, USER: 'operator' },
    });
    const { client } = await connect(url);

    const result = await client.callTool({ arguments: {}, name: 'environment' });

    expect(JSON.parse(firstText(result) ?? '{}')).not.toHaveProperty('USER');
  });

  test("logs the Child's stderr, tagged with its Service and Session", async () => {
    const { lines, url } = start();
    const { transport } = await connect(url);

    await waitFor(() => lines.some((line) => line.includes('stderr: stub-service started')));
    expect(lines).toContainEqual(
      `stub session ${transport.sessionId?.slice(0, 8) ?? ''} stderr: stub-service started`,
    );
  });
});

describe('ending a Session', () => {
  test('DELETE ends the Session, and later requests on it get 404', async () => {
    const { listener, url } = start();
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
    const { lines, listener, url } = start();
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
    const { lines, listener, url } = start({ idleMinutes: 0.005 });
    await connect(url);

    await waitFor(() => listener.sessionCount() === 0);
    expect(lines.some((line) => line.endsWith('ended: idle.'))).toBe(true);
  });
});

describe('refusals', () => {
  test('a request without the token gets 401 with a Bearer challenge', async () => {
    const { listener, url } = start();

    const response = await post(url, {});

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(listener.sessionCount()).toBe(0);
  });

  test('a request with a wrong token gets 401', async () => {
    const { url } = start();

    expect((await post(url, { Authorization: 'Bearer wrong' })).status).toBe(401);
    let refused = false;
    try {
      await connect(url, { token: 'wrong' });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test('an unknown session id gets 404', async () => {
    const { url } = start();

    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': crypto.randomUUID(),
    });

    expect(response.status).toBe(404);
  });

  test('an unknown Service path gets 404', async () => {
    const { url } = start();

    const response = await post(new URL('/other/mcp', url), { Authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(404);
  });

  test('a foreign Origin gets 403, and an allowed one passes', async () => {
    const { url } = start({ origins: ['https://claude.ai'] });

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
    const { listener, url } = start();

    const response = await post(
      url,
      { Authorization: `Bearer ${TOKEN}` },
      JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
    );

    expect(response.status).toBe(400);
    expect(listener.sessionCount()).toBe(0);
  });

  test('a new Session past the maximum gets 503', async () => {
    const { url } = start({ maxSessions: 1 });
    await connect(url);

    const response = await post(url, { Authorization: `Bearer ${TOKEN}` });

    expect(response.status).toBe(503);
  });
});
