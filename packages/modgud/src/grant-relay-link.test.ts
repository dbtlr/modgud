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
  // Whether each delivery counted as Session activity, in delivery order.
  const activities: boolean[] = [];
  const session: GrantSession = {
    activity: 0,
    deliver: (message, options) => {
      delivered.push(message);
      activities.push(options.activity);
    },
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
  return { activities, answerTo, delivered, entries, errorTo, initializes, relay, session, stub };
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

test.each(['capabilities', 'serverInfo'])(
  'a Link with over-deep %s fails its start and answers the waiting request',
  async (field) => {
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
                `{"id":${JSON.stringify((request.message as { id: number }).id)},"jsonrpc":"2.0","result":{"capabilities":${field === 'capabilities' ? nestedJson(depth) : '{}'},"protocolVersion":"2025-11-25","serverInfo":${field === 'serverInfo' ? nestedJson(depth) : '{"name":"s","version":"1"}'}}}`,
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
  },
);

// A tools/call answer whose result nests `depth` levels deep, as text the stub
// sends untouched, since stringifying such a value would overflow the stack.
const deepResult = (request: StubHttpRequest, depth: number) =>
  new Response(
    `{"id":${JSON.stringify((request.message as { id: number }).id)},"jsonrpc":"2.0","result":{"x":${nestedJson(depth)}}}`,
    { headers: { 'content-type': 'application/json' } },
  );

test('a Link whose result nests too deeply gives the Caller an error and keeps serving', async () => {
  const { answerTo, delivered, entries, errorTo, relay, session } = await fixture({
    respond: (request, calls) =>
      calls === 1 && httpMethod(request) === 'tools/call'
        ? deepResult(request, 100_000)
        : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => answerTo(1) !== undefined);
  relay.forward(session, toolRequest(2));
  await eventually(() => answerTo(2) !== undefined);

  expect(delivered.filter((message) => 'id' in message && message.id === 1)).toHaveLength(1);
  expect(errorTo(1)).toBe(ERRORS.tooDeep.message);
  expect(errorTo(2)).toBeUndefined();
  const refusals = entries.filter((entry) => entry.message.includes('nested too deeply'));
  expect(refusals.map((entry) => entry.level)).toEqual(['warn']);
});

test('a refused deep answer frees its request slot, so a Grant at its limit keeps serving', async () => {
  const { answerTo, errorTo, relay, session } = await fixture({
    // One open request at a time: a leaked slot would refuse the next.
    limits: { requestsPerGrant: 1 },
    respond: (request, calls) =>
      calls <= 3 && httpMethod(request) === 'tools/call' ? deepResult(request, 100_000) : undefined,
  });
  for (const id of [1, 2, 3]) {
    relay.forward(session, toolRequest(id));
    // oxlint-disable-next-line no-await-in-loop -- each request must be answered before the next is sent
    await eventually(() => answerTo(id) !== undefined);
    expect(errorTo(id)).toBe(ERRORS.tooDeep.message);
  }
  relay.forward(session, toolRequest(4));
  await eventually(() => answerTo(4) !== undefined);

  expect(errorTo(4)).toBeUndefined();
});

// A tools/call error response whose `data` nests `depth` levels deep.
const errorWithData = (request: StubHttpRequest, depth: number) =>
  new Response(
    `{"id":${JSON.stringify((request.message as { id: number }).id)},"jsonrpc":"2.0","error":{"code":-32602,"data":${nestedJson(depth)},"message":"Invalid params"}}`,
    { headers: { 'content-type': 'application/json' } },
  );

test('a Link error response within the limit reaches the Caller unchanged', async () => {
  const { answerTo, relay, session } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call' ? errorWithData(request, 1) : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => answerTo(1) !== undefined);

  expect(answerTo(1)).toEqual({
    error: { code: -32_602, data: {}, message: 'Invalid params' },
    id: 1,
    jsonrpc: '2.0',
  });
});

test('a Link whose error response nests too deeply gives the Caller the fixed error once', async () => {
  const { activities, delivered, errorTo, relay, session } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call' ? errorWithData(request, 100_000) : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => errorTo(1) !== undefined);
  // Let a second delivery for the same request, were one sent, arrive.
  await Bun.sleep(50);

  expect(errorTo(1)).toBe(ERRORS.tooDeep.message);
  expect(delivered).toHaveLength(1);
  // The refusal answers the Caller's request, so it counts as activity.
  expect(activities).toEqual([true]);
});

// A tools/call answer streamed after one notification whose params carry
// `x` nested `depth` levels, so the params nest one level more.
const notificationThenResult = (request: StubHttpRequest, notification: string, depth: number) => {
  const { id, params } = request.message as {
    id: number;
    params: { _meta?: { progressToken: number } };
  };
  const progress =
    params._meta === undefined
      ? ''
      : `"progress":1,"progressToken":${String(params._meta.progressToken)},`;
  const sent = `{"jsonrpc":"2.0","method":"${notification}","params":{${progress}"x":${nestedJson(depth)}}}`;
  const result = `{"id":${String(id)},"jsonrpc":"2.0","result":{"content":[]}}`;
  return httpStream([`data: ${sent}\n\n`, `data: ${result}\n\n`]);
};

test.each([
  [63, 2],
  [64, 1],
])(
  'a Link progress notification whose params nest %d levels past the first leaves %d messages delivered',
  async (depth, count) => {
    const { answerTo, delivered, relay, session } = await fixture({
      respond: (request) =>
        httpMethod(request) === 'tools/call'
          ? notificationThenResult(request, 'notifications/progress', depth)
          : undefined,
    });
    relay.forward(session, {
      ...toolRequest(1),
      params: { ...toolRequest(1).params, _meta: { progressToken: 'p' } },
    });
    await eventually(() => answerTo(1) !== undefined);

    // Params with `x` at 63 levels nest 64 deep, within the limit; at 64, past it.
    expect(delivered).toHaveLength(count);
  },
);

test.each([
  [1, 2],
  [100_000, 1],
])(
  'a Link tools/list_changed notification nested %d levels in its params leaves %d messages delivered',
  async (depth, count) => {
    const { answerTo, delivered, relay, session } = await fixture({
      // A Session that has initialized, so list_changed reaches it.
      given: { capabilities: '{}', protocolVersion: '2025-11-25' },
      respond: (request) =>
        httpMethod(request) === 'tools/call'
          ? notificationThenResult(request, 'notifications/tools/list_changed', depth)
          : undefined,
    });
    relay.forward(session, toolRequest(1));
    await eventually(() => answerTo(1) !== undefined);
    await Bun.sleep(50);

    expect(delivered).toHaveLength(count);
  },
);

test('a Link whose result nests exactly to the limit is delivered unchanged', async () => {
  const { answerTo, relay, session } = await fixture({
    respond: (request) =>
      httpMethod(request) === 'tools/call' ? deepResult(request, 63) : undefined,
  });
  relay.forward(session, toolRequest(1));
  await eventually(() => answerTo(1) !== undefined);

  expect(answerTo(1)).toEqual({
    id: 1,
    jsonrpc: '2.0',
    result: { x: JSON.parse(nestedJson(63)) as unknown },
  });
});

test('a Link that sends a progress notification nested too deeply has it dropped and its result delivered', async () => {
  const { answerTo, delivered, relay, session } = await fixture({
    respond: (request) => {
      if (httpMethod(request) !== 'tools/call') {
        return undefined;
      }
      const { id, params } = request.message as {
        id: number;
        params: { _meta: { progressToken: number } };
      };
      const progress = `{"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1,"progressToken":${String(params._meta.progressToken)},"x":${nestedJson(100_000)}}}`;
      const result = `{"id":${String(id)},"jsonrpc":"2.0","result":{"content":[]}}`;
      return httpStream([`data: ${progress}\n\n`, `data: ${result}\n\n`]);
    },
  });
  relay.forward(session, {
    ...toolRequest(1),
    params: { ...toolRequest(1).params, _meta: { progressToken: 'p' } },
  });
  await eventually(() => answerTo(1) !== undefined);

  expect(answerTo(1)).toEqual({ id: 1, jsonrpc: '2.0', result: { content: [] } });
  expect(delivered).toHaveLength(1);
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
