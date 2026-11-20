import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import packageMetadata from '../package.json';
import { createLink } from './link.ts';
import type { LinkOptions } from './link.ts';
import {
  httpEvent,
  httpId,
  httpMethod,
  httpStream,
  resetHttpResponse,
  rpcResult,
  startStubHttpService,
} from './testing/stub-http-service.ts';
import type { StubHttpRequest } from './testing/stub-http-service.ts';
import type { Upstream } from './upstream.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- stop the Link before its Service
    await cleanup();
  }
});

const fixture = async (
  stubOptions?: Parameters<typeof startStubHttpService>[0],
  limits?: LinkOptions['limits'],
) => {
  const stub = startStubHttpService(stubOptions);
  cleanups.push(() => stub.server.stop(true));
  const scratch = join(import.meta.dir, '../../../.scratch');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, 'link-'));
  const bearerPath = join(home, 'token');
  await writeFile(bearerPath, ' startup-token\n');
  const messages: JSONRPCMessage[] = [];
  const failures: number[] = [];
  const stops: { reason: string; failure: boolean }[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let nextId = 0;
  const options: LinkOptions = {
    events: {
      onMessage: (message) => messages.push(message),
      onRequestFailed: (id) => failures.push(id),
      onStopped: (reason, failure) => stops.push({ failure, reason }),
    },
    home,
    label: 'stub link for static-token',
    ...(limits === undefined ? {} : { limits }),
    log: { info: (line) => infos.push(line), warn: (warning) => warnings.push(warning) },
    nextId: () => ++nextId,
    service: {
      bearer_file: '~/token',
      idle_timeout_minutes: 1,
      kind: 'http',
      tool_list_max_age_seconds: 60,
      url: stub.url,
    },
  };
  const link: Upstream = createLink(options);
  cleanups.push(() => {
    link.stop('shutdown');
    return link.stopped;
  });
  return {
    ...stub,
    bearerPath,
    failures,
    ids: () => nextId,
    infos,
    link,
    messages,
    options,
    stops,
    warnings,
  };
};

test('sends only the Link headers with no Origin', async () => {
  const { link, requests } = await fixture({ protocolVersion: '2025-06-18', sessionId: 'session' });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  const baseHeaders = {
    accept: 'application/json, text/event-stream',
    'accept-encoding': 'identity',
    authorization: 'Bearer startup-token',
    connection: 'keep-alive',
    'content-length': expect.stringMatching(/^\d+$/u),
    'content-type': 'application/json',
    host: expect.stringMatching(/^127\.0\.0\.1:\d+$/u),
    'user-agent': `modgud/${packageMetadata.version}`,
  };
  expect(Object.fromEntries(requests[0]?.headers ?? [])).toEqual(baseHeaders);
  expect(Object.fromEntries(requests[1]?.headers ?? [])).toEqual({
    ...baseHeaders,
    'mcp-protocol-version': '2025-06-18',
    'mcp-session-id': 'session',
  });
  expect(requests.some(({ headers }) => new Headers(headers).has('Origin'))).toBe(false);
});

test('initializes at 2025-11-25 before the initialized notification', async () => {
  const { link, requests, ids } = await fixture({ protocolVersion: '2025-06-18' });
  expect(await link.start()).toMatchObject({
    kind: 'started',
    result: { protocolVersion: '2025-06-18' },
  });
  expect(requests.map(({ method, path, message }) => ({ message, method, path }))).toEqual([
    {
      message: {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'modgud', version: packageMetadata.version },
          protocolVersion: '2025-11-25',
        },
      },
      method: 'POST',
      path: '/mcp',
    },
    {
      message: { jsonrpc: '2.0', method: 'notifications/initialized' },
      method: 'POST',
      path: '/mcp',
    },
  ]);
  expect(ids()).toBe(1);
  expect(link.restartsAtOnce).toBe(true);
  expect(link.workOutlivesStop).toBe(true);
});

test.each([
  ['bad initialize protocol', { protocolVersion: '2026-07-28' }],
  [
    'session rejected during initialize',
    {
      respond: (request: StubHttpRequest) =>
        httpMethod(request) === 'notifications/initialized'
          ? new Response(null, { status: 404 })
          : undefined,
      sessionId: 'session',
    },
  ],
  [
    'nonempty initialized answer',
    {
      respond: (request: StubHttpRequest) =>
        httpMethod(request) === 'notifications/initialized'
          ? new Response('unexpected', { status: 202 })
          : undefined,
    },
  ],
  [
    'initialize RPC error',
    {
      respond: (request: StubHttpRequest) =>
        httpMethod(request) === 'initialize'
          ? Response.json({
              error: { code: -32603, message: 'not ready' },
              id: httpId(request),
              jsonrpc: '2.0',
            })
          : undefined,
    },
  ],
] satisfies [string, NonNullable<Parameters<typeof startStubHttpService>[0]>][])(
  'fails start on %s',
  async (_scenario, options) => {
    const { link, stops } = await fixture(options);
    expect(await link.start()).toMatchObject({ kind: 'failed' });
    await link.stopped;
    expect(stops).toEqual([]);
  },
);

test('logs the bearer failure category without the file contents', async () => {
  const { link, bearerPath, requests, warnings } = await fixture();
  await writeFile(bearerPath, 'secret with spaces');
  expect(await link.start()).toMatchObject({ kind: 'failed' });
  expect(requests).toEqual([]);
  expect(warnings).toEqual([
    expect.stringMatching(/^stub link for static-token .*token.*invalid secret/u),
  ]);
  expect(warnings.join('')).not.toContain('secret with spaces');
});

test('applies one deadline to the whole start handshake', async () => {
  const { link, requests } = await fixture(
    {
      async respond(request) {
        if (httpMethod(request) === 'initialize') {
          await Bun.sleep(70);
          return Response.json(
            rpcResult(httpId(request), {
              capabilities: {},
              protocolVersion: '2025-11-25',
              serverInfo: {},
            }),
          );
        }
        await Bun.sleep(70);
        return new Response(null, { status: 202 });
      },
    },
    { startDeadlineMs: 115 },
  );
  expect(await link.start()).toEqual({ kind: 'failed', reason: 'start deadline exceeded' });
  await link.stopped;
  expect(requests.map(httpMethod)).toEqual(['initialize', 'notifications/initialized']);
});

test('stop interrupts a pending start without events', async () => {
  const arrived = Promise.withResolvers<void>();
  const { link, messages, failures, stops } = await fixture({
    respond() {
      arrived.resolve();
      return httpStream([], { hang: true });
    },
  });
  const starting = link.start();
  await arrived.promise;
  link.stop('idle');
  expect(await starting).toMatchObject({ kind: 'failed' });
  await link.stopped;
  expect({ failures, messages, stops }).toEqual({ failures: [], messages: [], stops: [] });
});

const eventually = async (condition: () => boolean) => {
  const deadline = performance.now() + 1500;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error('Condition was not met');
    }
    // oxlint-disable-next-line no-await-in-loop -- wait for HTTP activity without a fixed delay
    await Bun.sleep(2);
  }
};

const toolRequest = (id: number) =>
  ({
    id,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: { text: 'hello' }, name: 'echo' },
  }) as const;
const progress = {
  jsonrpc: '2.0',
  method: 'notifications/progress',
  params: { progress: 1, progressToken: 7 },
} as const;

test('delivers SSE messages in order and cancels the body after the response', async () => {
  const reply = rpcResult(7, { text: 'é' });
  const servicePing = { id: 'service-ping', jsonrpc: '2.0', method: 'ping' } as const;
  const bytes = new TextEncoder().encode(
    `${String.fromCodePoint(65279)}: hello\r\nid: 2\r\nretry: 500\r\ndata:\r\n\r\n${httpEvent(progress)}${httpEvent(servicePing)}data: {"jsonrpc":"2.0",\rdata: "id":7,"result":{"text":"é"}}\r\n\r\n${httpEvent({ jsonrpc: '2.0', method: 'notifications/ignored' })}`,
  );
  const split = bytes.indexOf(195) + 1;
  let closed = false;
  const { link, messages, failures } = await fixture({
    respond(request) {
      if (httpMethod(request) === 'tools/call') {
        return httpStream([bytes.subarray(0, split), bytes.subarray(split)], {
          cancelled: () => {
            closed = true;
          },
          hang: true,
        });
      }
      return undefined;
    },
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => messages.length === 3 && closed);
  expect(messages).toEqual([progress, servicePing, reply]);
  expect(failures).toEqual([]);
});

test('fails a request when its SSE stream ends before the response', async () => {
  const { link, messages, failures, requests } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call' ? httpStream([httpEvent(progress)]) : undefined,
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => failures.length === 1);
  expect(failures).toEqual([7]);
  expect(messages).toEqual([progress]);
  expect(requests.every(({ method }) => method === 'POST')).toBe(true);
});

test('rejects an oversized SSE event before it ends', async () => {
  const { link, failures, messages } = await fixture(
    {
      respond: (request) =>
        httpMethod(request) === 'tools/call'
          ? httpStream([httpEvent(progress), 'data: ', 'x'.repeat(800)], { hang: true })
          : undefined,
    },
    { messageBytes: 512 },
  );
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => failures.length === 1);
  expect(failures).toEqual([7]);
  expect(messages).toEqual([progress]);
});

test('bounds JSON after decompression', async () => {
  // oxlint-disable-next-line node/no-sync -- the test compresses a small fixed fixture in memory
  const compressed = Bun.gzipSync(JSON.stringify(rpcResult(7, { text: 'é'.repeat(300) })));
  expect(compressed.byteLength).toBeLessThan(512);
  const { link, failures } = await fixture(
    {
      respond: (request) =>
        httpMethod(request) === 'tools/call'
          ? new Response(compressed, {
              headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
            })
          : undefined,
    },
    { messageBytes: 512 },
  );
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => failures.length === 1);
  expect(failures).toEqual([7]);
});

test('rejects a redirect without sending a request to its location', async () => {
  const target = startStubHttpService();
  cleanups.push(() => target.server.stop(true));
  const { link, failures, stops } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call'
        ? new Response(null, { headers: { Location: target.url }, status: 307 })
        : undefined,
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => failures.length === 1);
  expect(failures).toEqual([7]);
  expect(stops).toEqual([]);
  expect(target.requests).toEqual([]);
});

test('bypasses proxy environment variables on every Link request', async () => {
  // The runner's fetch can retain proxy configuration. Set it only in a child.
  const proxyRequests: string[] = [];
  const proxy = Bun.serve({
    fetch(request) {
      proxyRequests.push(request.url);
      return new Response(null, { status: 502 });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  cleanups.push(() => proxy.stop(true));
  const { options, requests } = await fixture({ sessionId: 'session' });
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { createLink } from ${JSON.stringify(join(import.meta.dir, 'link.ts'))};
    const link = createLink({
      service: ${JSON.stringify(options.service)},
      home: ${JSON.stringify(options.home)},
      label: 'stub link for static-token',
      log: { warn() {}, info() {} },
      events: { onMessage() {}, onRequestFailed() {}, onStopped() {} },
      nextId: () => 1,
      limits: { startDeadlineMs: 1000, auxiliaryTimeoutMs: 200 },
    });
    if ((await link.start()).kind === 'failed') process.exitCode = 1;
    link.stop('idle');
    await link.stopped;
  `,
    ],
    {
      env: {
        ...process.env,
        HTTP_PROXY: proxy.url.href,
        NO_PROXY: '',
        http_proxy: proxy.url.href,
        no_proxy: '',
      },
    },
  );
  expect(await child.exited).toBe(0);
  expect(proxyRequests).toEqual([]);
  expect(requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'DELETE']);
});

test('keeps the initialized session and original bearer through one DELETE', async () => {
  const { link, requests, messages, bearerPath, stops } = await fixture({ sessionId: 'session' });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  await writeFile(bearerPath, 'a-new-bearer');
  link.request(toolRequest(7));
  await eventually(() => messages.length === 1);
  link.stop('idle');
  link.stop('authorization ended');
  await link.stopped;

  expect(requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'POST', 'DELETE']);
  expect(new Headers(requests[0]?.headers).has('Mcp-Session-Id')).toBe(false);
  for (const { headers } of requests.slice(1)) {
    expect(new Headers(headers).get('Mcp-Session-Id')).toBe('session');
    expect(new Headers(headers).get('MCP-Protocol-Version')).toBe('2025-11-25');
    expect(new Headers(headers).get('Authorization')).toBe('Bearer startup-token');
  }
  expect(stops).toEqual([]);
});

test.each([
  [401, true],
  [404, false],
] as const)('stops on HTTP %i with an active session', async (status, failure) => {
  const { link, requests, stops, messages, failures } = await fixture({
    respond(request) {
      if (httpMethod(request) === 'tools/call') {
        return httpId(request) === 7
          ? httpStream([], { hang: true })
          : new Response(null, { status });
      }
      return undefined;
    },
    sessionId: 'session',
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => requests.length === 3);
  link.request(toolRequest(8));
  await eventually(() => stops.length === 1);
  await link.stopped;
  expect(stops).toEqual([{ failure, reason: expect.any(String) }]);
  expect({ failures, messages }).toEqual({ failures: [], messages: [] });
  expect(requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'POST', 'POST']);
  expect(requests.map(httpMethod)).not.toContain('notifications/cancelled');
});

test('stops with backoff when a running Service refuses the connection', async () => {
  const { link, server, stops, failures } = await fixture();
  expect(await link.start()).toMatchObject({ kind: 'started' });
  await server.stop(true);
  link.request(toolRequest(7));
  await eventually(() => stops.length > 0);
  expect(stops).toEqual([{ failure: true, reason: 'Service refused the connection' }]);
  expect(failures).toEqual([]);
  await link.stopped;
});

test('fails start when the Service refuses the connection', async () => {
  const { link, server, stops } = await fixture();
  await server.stop(true);
  expect(await link.start()).toEqual({ kind: 'failed', reason: 'Service refused the connection' });
  expect(stops).toEqual([]);
});

test.each([
  ['reset connection', () => resetHttpResponse()],
  ['HTTP 202 for a request', () => new Response(null, { status: 202 })],
  ['HTTP 404 without a session', () => new Response(null, { status: 404 })],
  [
    'unexpected media type',
    () => Response.json(rpcResult(7), { headers: { 'content-type': 'text/plain' } }),
  ],
  ['invalid JSON-RPC', () => Response.json({ id: 7, jsonrpc: '2.0' })],
  ['wrong response id', () => Response.json(rpcResult(97))],
] satisfies [string, () => Response][])(
  'fails only the request on %s',
  async (_scenario, reply) => {
    const { link, messages, failures, stops } = await fixture({
      respond: (request) =>
        httpMethod(request) === 'tools/call' && httpId(request) === 7 ? reply() : undefined,
    });
    expect(await link.start()).toMatchObject({ kind: 'started' });
    link.request(toolRequest(7));
    await eventually(() => failures.length === 1);
    link.request(toolRequest(8));
    await eventually(() => messages.length === 1);
    expect(failures).toEqual([7]);
    expect(messages).toEqual([rpcResult(8, { content: [{ text: 'hello', type: 'text' }] })]);
    expect(stops).toEqual([]);
  },
);

test('logs and drops a bad answer to a Service response POST', async () => {
  const { link, warnings, stops, requests } = await fixture({
    respond: (request) =>
      httpMethod(request) === undefined ? new Response(null, { status: 500 }) : undefined,
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  const reply = rpcResult('service-ping');
  link.answer(reply);
  await eventually(() => warnings.length === 1);
  expect(warnings[0]).toContain('bad answer');
  expect(requests[2]?.message).toEqual(reply);
  expect(stops).toEqual([]);
});

test('stops with backoff on a 401 to a Service response POST', async () => {
  const { link, requests, stops } = await fixture({
    respond: (request) =>
      httpMethod(request) === undefined ? new Response(null, { status: 401 }) : undefined,
    sessionId: 'session',
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.answer(rpcResult('service-ping'));
  await eventually(() => stops.length === 1);
  await link.stopped;
  expect(stops[0]?.failure).toBe(true);
  expect(requests.map(({ method }) => method)).toEqual(['POST', 'POST', 'POST']);
});

test('posts the rewritten cancellation and aborts the request without events', async () => {
  let streamClosed = false;
  const { link, requests, messages, failures, stops } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call'
        ? httpStream([httpEvent(progress)], {
            cancelled: () => {
              streamClosed = true;
            },
            hang: true,
          })
        : undefined,
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => messages.length === 1);
  link.cancel(7, { reason: 'caller left', requestId: 'caller-id' });
  await eventually(() => streamClosed && requests.length === 4);
  expect(requests[3]?.message).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { reason: 'caller left', requestId: 7 },
  });
  link.cancel(7, undefined);
  link.stop('idle');
  await link.stopped;
  expect(requests).toHaveLength(4);
  expect({ failures, messages, stops }).toEqual({ failures: [], messages: [progress], stops: [] });
});

test('stop cancels work and waits for the last auxiliary response', async () => {
  const cancellation = Promise.withResolvers<Response>();
  const deletion = Promise.withResolvers<Response>();
  let closed = false;
  const { link, messages, failures, stops, requests } = await fixture(
    {
      respond(request) {
        if (request.method === 'DELETE') {
          return deletion.promise;
        }
        switch (httpMethod(request)) {
          case 'tools/call': {
            return httpStream([httpEvent(progress)], {
              cancelled: () => {
                closed = true;
              },
              hang: true,
            });
          }
          case 'notifications/cancelled': {
            return cancellation.promise;
          }
          default: {
            return undefined;
          }
        }
      },
      sessionId: 'session',
    },
    { auxiliaryTimeoutMs: 300 },
  );
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  await eventually(() => messages.length === 1);
  const waiting = Promise.resolve('waiting');
  link.stop('authorization ended');
  await eventually(() => closed && requests.length === 5);
  expect(await Promise.race([link.stopped, waiting])).toBe('waiting');
  cancellation.resolve(new Response(null, { status: 202 }));
  await Bun.sleep(10);
  expect(await Promise.race([link.stopped, waiting])).toBe('waiting');
  deletion.resolve(new Response(null, { status: 204 }));
  await link.stopped;
  expect(requests.map(httpMethod)).toContain('notifications/cancelled');
  expect({ failures, messages, stops }).toEqual({ failures: [], messages: [progress], stops: [] });
});

test.each([401, 404])(
  'ignores HTTP %i from a stopped Link’s cancellation and DELETE',
  async (status) => {
    const { link, requests, stops, warnings } = await fixture({
      respond(request) {
        if (request.method === 'DELETE' || httpMethod(request) === 'notifications/cancelled') {
          return new Response(null, { status });
        }
        if (httpMethod(request) === 'tools/call') {
          return httpStream([], { hang: true });
        }
        return undefined;
      },
      sessionId: 'session',
    });
    expect(await link.start()).toMatchObject({ kind: 'started' });
    link.request(toolRequest(7));
    await eventually(() => requests.length === 3);
    link.stop('idle');
    await link.stopped;
    expect(requests.map(httpMethod)).toContain('notifications/cancelled');
    expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
    expect(stops).toEqual([]);
    expect(warnings).toEqual([]);
  },
);

test('shutdown sends cancellations and aborts requests and auxiliaries without waiting', async () => {
  const closed = new Set<string>();
  const { link, messages, failures, stops, requests } = await fixture(
    {
      respond(request) {
        const method = httpMethod(request);
        if (method === 'tools/call') {
          return httpStream([httpEvent(progress)], {
            cancelled: () => closed.add('request'),
            hang: true,
          });
        }
        if (method === 'notifications/cancelled') {
          return httpStream([], {
            cancelled: () => closed.add('cancellation'),
            hang: true,
            status: 202,
          });
        }
        if (method === undefined) {
          return httpStream([], { cancelled: () => closed.add('answer'), hang: true, status: 202 });
        }
        return undefined;
      },
    },
    { auxiliaryTimeoutMs: 1500 },
  );
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  link.answer(rpcResult('service-ping'));
  await eventually(() => messages.length === 1 && requests.length === 4);
  link.stop('shutdown');
  expect(await Promise.race([link.stopped, Bun.sleep(250).then(() => 'waiting')])).toBeUndefined();
  await eventually(() => closed.size === 3);
  expect(requests.map(httpMethod)).toContain('notifications/cancelled');
  expect({ failures, messages, stops }).toEqual({ failures: [], messages: [progress], stops: [] });
});

test('bounds cancellations, answers and DELETE independently', async () => {
  const closed = new Set<string>();
  const { link, requests, warnings, stops } = await fixture(
    {
      respond(request) {
        const method = httpMethod(request);
        if (
          request.method === 'DELETE' ||
          method === 'notifications/cancelled' ||
          method === undefined
        ) {
          const kind = request.method === 'DELETE' ? 'delete' : (method ?? 'answer');
          const status = request.method === 'DELETE' ? 200 : 202;
          return httpStream([], { cancelled: () => closed.add(kind), hang: true, status });
        }
        if (method === 'tools/call') {
          return httpStream([], { hang: true });
        }
        return undefined;
      },
      sessionId: 'session',
    },
    { answersInFlight: 1, auxiliaryTimeoutMs: 150, cancellationsInFlight: 1 },
  );
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.request(toolRequest(7));
  link.request(toolRequest(8));
  await eventually(() => requests.length === 4);
  link.cancel(7, undefined);
  link.cancel(8, undefined);
  link.answer(rpcResult('first'));
  link.answer(rpcResult('second'));
  link.stop('idle');
  await link.stopped;
  await eventually(() => closed.size === 3);
  expect(
    requests.filter((request) => httpMethod(request) === 'notifications/cancelled'),
  ).toHaveLength(1);
  expect(
    requests.filter((request) => request.method === 'POST' && httpMethod(request) === undefined),
  ).toHaveLength(1);
  expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
  expect(warnings).toEqual([
    expect.stringContaining('dropping cancellation'),
    expect.stringContaining('dropping answer'),
  ]);
  expect(stops).toEqual([]);
});

test('logs a start and a stop with its reason, never the bearer', async () => {
  const { link, infos } = await fixture();
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.stop('idle');
  await link.stopped;
  expect(infos).toEqual([
    'stub link for static-token started.',
    'stub link for static-token stopped: idle.',
  ]);
  expect(infos.join('')).not.toContain('startup-token');
});

test('logs a failed start as a stop with its reason', async () => {
  const { link, bearerPath, infos } = await fixture();
  await writeFile(bearerPath, 'secret with spaces');
  await link.start();
  expect(infos).toHaveLength(1);
  expect(infos[0]).toMatch(/^stub link for static-token stopped: bearer file .*token: .+\.$/u);
  expect(infos[0]).not.toContain('secret with spaces');
});

test('logs a self-stop after a 401 without the Service text', async () => {
  const { link, infos, stops } = await fixture({
    respond: (request) =>
      httpMethod(request) === undefined
        ? new Response('echo of startup-token', { status: 401 })
        : undefined,
    sessionId: 'session',
  });
  expect(await link.start()).toMatchObject({ kind: 'started' });
  link.answer(rpcResult('service-ping'));
  await eventually(() => stops.length === 1);
  expect(infos).toEqual([
    'stub link for static-token started.',
    'stub link for static-token stopped: Service refused the bearer.',
  ]);
});
