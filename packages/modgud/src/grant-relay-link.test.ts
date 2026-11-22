// GrantRelay's rules for a Link (ADR-0005): what it keeps counting after a
// Link stops, what counts toward backoff, and when the next Link may start.
// Each test drives a real GrantRelay and Link against the stub HTTP Service.
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/server';

import { GRANT_LIMITS, GrantRelay } from './grant-relay.ts';
import type { GrantLimits, GrantSession } from './grant-relay.ts';
import { createLink } from './link.ts';
import type { LinkOptions } from './link.ts';
import { ERRORS } from './protocol.ts';
import { createLogRecorder } from './testing/log-recorder.ts';
import { nestedJson } from './testing/nested-json.ts';
import { httpMethod, httpStream, startStubHttpService } from './testing/stub-http-service.ts';
import type { StubHttpRequest } from './testing/stub-http-service.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- end the relay before its Service
    await cleanup();
  }
});

// A fresh home for one test's bearer file, removed after the test.
const temporaryHome = async (prefix: string) => {
  const home = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(home, { force: true, recursive: true }));
  return home;
};

const eventually = async (condition: () => boolean, timeoutMs = 3000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error('Condition was not met');
    }
    // oxlint-disable-next-line no-await-in-loop -- wait for the relay without a fixed delay
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

// A relay over a real Link, and the one Session it serves.
const fixture = async ({
  given,
  idleTimeoutMs = 60_000,
  limits = {},
  linkLimits,
  missingBearer = false,
  respond,
}: {
  given?: GrantSession['given'];
  idleTimeoutMs?: number;
  missingBearer?: boolean;
  limits?: Partial<GrantLimits>;
  linkLimits?: LinkOptions['limits'];
  respond?: (request: StubHttpRequest, calls: number) => Response | Promise<Response> | undefined;
} = {}) => {
  let toolCalls = 0;
  const stub = startStubHttpService({
    respond: (request) => {
      if (httpMethod(request) === 'tools/call') {
        toolCalls += 1;
      }
      return respond?.(request, toolCalls);
    },
    sessionId: 'session',
  });
  cleanups.push(() => stub.server.stop(true));
  const home = await temporaryHome('modgud-relay-');
  if (!missingBearer) {
    await writeFile(join(home, 'token'), 'startup-token');
  }
  const { entries, log: recorded } = createLogRecorder();
  // The log of the relay's Grant, as the Public listener binds it.
  const log = recorded.with({ grant: 'static-token', service: 'stub', upstream: 'link' });
  const grantLimits: GrantLimits = { ...GRANT_LIMITS, ...limits };
  const relay = new GrantRelay({
    grant: 'static-token',
    idleTimeoutMs,
    limits: grantLimits,
    log,
    maxToolCallsPerMinute: 120,
    service: 'stub',
    upstream: (events, nextId) =>
      createLink({
        events,
        home,
        ...(linkLimits === undefined ? {} : { limits: linkLimits }),
        log,
        nextId,
        service: {
          bearer_file: '~/token',
          idle_timeout_minutes: 1,
          kind: 'http',
          max_tool_calls_per_minute: 120,
          tool_list_max_age_seconds: 60,
          url: stub.url,
        },
        startTimeoutMs: grantLimits.startTimeoutMs,
      }),
  });
  cleanups.push(async () => relay.end('shutdown'));
  const delivered: JSONRPCMessage[] = [];
  const session: GrantSession = {
    activity: 0,
    deliver: (message) => delivered.push(message),
    end: () => undefined,
    ended: false,
    given,
  };
  relay.admit(session, 64);
  const initializes = () => stub.requests.filter((r) => httpMethod(r) === 'initialize').length;
  // What the Caller was given for request `id`: an error message or a result.
  const answerTo = (id: RequestId) =>
    delivered.find((message) => 'id' in message && message.id === id);
  const errorTo = (id: RequestId) => {
    const answer = answerTo(id);
    return answer !== undefined && 'error' in answer ? answer.error.message : undefined;
  };
  return { answerTo, delivered, entries, errorTo, initializes, relay, session, stub };
};

test('a stopped Link keeps its hung request counting until the hold passes', async () => {
  const { answerTo, errorTo, relay, session } = await fixture({
    idleTimeoutMs: 100,
    limits: { cancelledHoldMs: 600, requestsPerGrant: 1 },
    respond: (_request, calls) =>
      calls === 1 && _request.method === 'POST' && httpMethod(_request) === 'tools/call'
        ? httpStream([], { hang: true })
        : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => errorTo(1) !== undefined);
  expect(errorTo(1)).toBe(ERRORS.stopped.message);

  relay.forward(session, toolRequest(2));
  expect(errorTo(2)).toBe(ERRORS.tooManyRequests.message);

  // Probe with a fresh id until the hold has passed and the Grant admits one.
  let probe = 3;
  relay.forward(session, toolRequest(probe));
  const deadline = performance.now() + 3000;
  while (errorTo(probe) === ERRORS.tooManyRequests.message) {
    if (performance.now() >= deadline) {
      throw new Error('The hold was not released');
    }
    // oxlint-disable-next-line no-await-in-loop -- poll for the hold's release without a fixed delay
    await Bun.sleep(10);
    probe += 1;
    relay.forward(session, toolRequest(probe));
  }
  await eventually(() => answerTo(probe) !== undefined);
  expect(errorTo(probe)).toBeUndefined();
});

test('one initialize with a missing bearer file starts one Link and records one failure', async () => {
  const { entries, initializes, relay } = await fixture({ missingBearer: true });
  expect(await relay.ready()).toEqual({ kind: 'failed' });
  // Let a second Link, were one started, reach its own bearer read.
  await Bun.sleep(50);
  // The Link's event carries the fields its Grant's log was bound with.
  expect(entries.filter((entry) => entry.message.includes('bearer file'))).toEqual([
    {
      fields: {
        error: expect.any(String),
        file: expect.stringMatching(/\/token$/u),
        grant: 'static-token',
        service: 'stub',
        upstream: 'link',
      },
      level: 'warn',
      message: '{service} {upstream} for {grant} bearer file {file}: {error}',
    },
  ]);
  expect(initializes()).toBe(0);
});

test('a Link whose capabilities nest too deeply to compare fails its start and answers the waiting request', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const depth = 100_000;
    const { errorTo, relay, session } = await fixture({
      // A Session given capabilities earlier, so a start compares them.
      given: { capabilities: '{}', protocolVersion: '2025-11-25' },
      respond: (request) =>
        httpMethod(request) === 'initialize'
          ? new Response(
              `{"id":${JSON.stringify((request.message as { id: number }).id)},"jsonrpc":"2.0","result":{"capabilities":${nestedJson(depth)},"protocolVersion":"2025-11-25","serverInfo":{"name":"s","version":"1"}}}`,
              { headers: { 'Mcp-Session-Id': 'session', 'content-type': 'application/json' } },
            )
          : undefined,
    });
    relay.forward(session, toolRequest(1));
    await eventually(() => errorTo(1) !== undefined);
    await Bun.sleep(50);

    expect(errorTo(1)).toBe(ERRORS.unavailable.message);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', record);
  }
});

test('after a 404 on the session id, the next request starts a new Link at once', async () => {
  const { answerTo, errorTo, initializes, relay, session } = await fixture({
    respond: (request, calls) =>
      calls === 1 && httpMethod(request) === 'tools/call'
        ? new Response(null, { status: 404 })
        : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => errorTo(1) !== undefined);

  relay.forward(session, toolRequest(2));
  await eventually(() => answerTo(2) !== undefined);
  expect(errorTo(2)).toBeUndefined();
  expect(initializes()).toBe(2);
});

test('after a 401, the next request fails at once during backoff', async () => {
  const { errorTo, initializes, relay, session } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call' ? new Response(null, { status: 401 }) : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => errorTo(1) !== undefined);

  relay.forward(session, toolRequest(2));
  await eventually(() => errorTo(2) !== undefined);
  expect(errorTo(2)).toBe(ERRORS.unavailable.message);
  expect(initializes()).toBe(1);
});

test("a new Link starts without waiting for the old Link's DELETE to settle", async () => {
  const { answerTo, errorTo, initializes, relay, session, stub } = await fixture({
    idleTimeoutMs: 100,
    linkLimits: { auxiliaryTimeoutMs: 3000 },
    respond: (request) =>
      // The Service never answers the DELETE.
      request.method === 'DELETE' ? Promise.withResolvers<Response>().promise : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => stub.requests.some(({ method }) => method === 'DELETE'));
  expect(errorTo(1)).toBeUndefined();

  const started = performance.now();
  relay.forward(session, toolRequest(2));
  await eventually(() => answerTo(2) !== undefined);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(initializes()).toBe(2);
});

test('ending a relay for shutdown leaves no timers that keep the process alive', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { GRANT_LIMITS, GrantRelay } from ${JSON.stringify(join(import.meta.dir, 'grant-relay.ts'))};
    import { createLink } from ${JSON.stringify(join(import.meta.dir, 'link.ts'))};
    const received = Promise.withResolvers();
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const message = request.method === 'POST' ? await request.json() : undefined;
        if (message?.method === 'tools/call') {
          received.resolve();
          return new Response(new ReadableStream({}), { headers: { 'content-type': 'text/event-stream' } });
        }
        if (message?.method === 'initialize') {
          return Response.json({ id: message.id, jsonrpc: '2.0', result: { capabilities: {}, protocolVersion: '2025-11-25', serverInfo: { name: 's', version: '1' } } });
        }
        return new Response(null, { status: message === undefined ? 204 : 202 });
      },
    });
    const log = { info() {}, warn() {}, with() { return log; } };
    const home = ${JSON.stringify(await temporaryHome('modgud-linger-'))};
    await Bun.write(home + '/token', 'secret');
    const relay = new GrantRelay({
      grant: 'g', idleTimeoutMs: 60_000, service: 's', log,
      limits: { ...GRANT_LIMITS, cancelledHoldMs: 30_000 },
      upstream: (events, nextId) => createLink({ events, home, log, nextId, startTimeoutMs: 5000,
        service: { kind: 'http', url: new URL('/mcp', stub.url).href, bearer_file: '~/token', idle_timeout_minutes: 1, tool_list_max_age_seconds: 60 } }),
    });
    const session = { activity: 0, deliver() {}, end() {}, ended: false, given: undefined };
    relay.admit(session, 64);
    relay.forward(session, { id: 1, jsonrpc: '2.0', method: 'tools/call', params: {} });
    const deadline = setTimeout(() => {
      console.error('The stub never received tools/call');
      process.exit(2);
    }, 5000);
    await received.promise;
    clearTimeout(deadline);
    await relay.end('shutdown');
    await stub.stop(true);
  `,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const started = performance.now();
  expect(await child.exited).toBe(0);
  expect(performance.now() - started).toBeLessThan(10_000);
}, 15_000);
