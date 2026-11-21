// ADR-0006's tool call limit: each Grant sends at most its Service's
// max_tool_calls_per_minute tools/call requests in any 60 seconds, and a call
// past it gets a tool error the model can read. Each test drives a real
// GrantRelay over a scripted Upstream and a clock the test moves.
import { afterEach, describe, expect, test } from 'bun:test';

import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '@modelcontextprotocol/server';

import { GRANT_LIMITS, GrantRelay } from './grant-relay.ts';
import type { GrantLimits, GrantSession } from './grant-relay.ts';
import { ERRORS } from './protocol.ts';
import { createLogRecorder } from './testing/log-recorder.ts';
import type { LogEntry } from './testing/log-recorder.ts';
import type { StartResult, Upstream, UpstreamEvents } from './upstream.ts';

const SECOND = 1000;

// What the relay's Grant binds to every event of its log.
const BOUND = { grant: 'static-token', service: 'stub', upstream: 'child' };
const LIMIT_REACHED =
  '{service} {upstream} for {grant} refused a tool call: the Grant reached its limit of {limit} per minute.';

// The entry that ends an episode that refused `refused` tool calls.
const episodeEnd = (refused: number): LogEntry => ({
  fields: { ...BOUND, refused },
  level: 'info',
  message:
    '{service} {upstream} for {grant} ended a tool call limit episode: it refused {refused} in the episode.',
});

const relays: GrantRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map(async (relay) => relay.end('shutdown')));
});

// Lets the relay act on an Upstream's start or stop, which settle as promises.
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- let each queued step run in turn
    await Bun.sleep(0);
  }
};

// One run of the scripted Service. It answers each request it is sent at
// once, unless `holding` keeps its answers back, and starts as soon as asked
// unless `startGate` holds the start or `failStarts` fails it.
type ScriptedRun = {
  sent: JSONRPCRequest[];
  // Stops the run as a Child that exits, or a Link whose Service went away.
  crash: () => void;
};

const scriptedService = ({ restartsAtOnce }: { restartsAtOnce: boolean }) => {
  const runs: ScriptedRun[] = [];
  const held: { events: UpstreamEvents; id: RequestId }[] = [];
  const control = {
    failStarts: 0,
    holding: false,
    startGate: undefined as Promise<void> | undefined,
  };
  const factory = (events: UpstreamEvents): Upstream => {
    const stopped = Promise.withResolvers<void>();
    const run: ScriptedRun = {
      crash: () => {
        events.onStopped('exited', false);
        stopped.resolve();
      },
      sent: [],
    };
    runs.push(run);
    return {
      answer: () => undefined,
      cancel: () => undefined,
      request: (message) => {
        run.sent.push(message);
        if (control.holding) {
          held.push({ events, id: message.id });
          return;
        }
        events.onMessage({ id: message.id, jsonrpc: '2.0', result: { content: [] } });
      },
      restartsAtOnce,
      start: async (): Promise<StartResult> => {
        await control.startGate;
        if (control.failStarts > 0) {
          control.failStarts -= 1;
          stopped.resolve();
          return { kind: 'failed', reason: 'scripted failure' };
        }
        return {
          kind: 'started',
          result: { capabilities: { tools: {} }, protocolVersion: '2025-11-25', serverInfo: {} },
        };
      },
      stop: () => stopped.resolve(),
      stopped: stopped.promise,
      // As for the real Upstreams: a Child's work stops with it, a Link's may not.
      workOutlivesStop: restartsAtOnce,
    };
  };
  // Answers every request held back.
  const answerHeld = () => {
    for (const { events, id } of held.splice(0)) {
      events.onMessage({ id, jsonrpc: '2.0', result: { content: [] } });
    }
  };
  const sentTools = () =>
    runs.flatMap((run) => run.sent).filter((message) => message.method === 'tools/call');
  return { answerHeld, control, factory, runs, sentTools };
};

const fixture = ({
  limit,
  limits = {},
  restartsAtOnce = false,
}: {
  limit: number;
  limits?: Partial<GrantLimits>;
  restartsAtOnce?: boolean;
}) => {
  const clock = { now: 0 };
  const service = scriptedService({ restartsAtOnce });
  const { entries, log } = createLogRecorder();
  const relay = new GrantRelay({
    grant: 'static-token',
    idleTimeoutMs: 60 * 60 * SECOND,
    limits: { ...GRANT_LIMITS, ...limits },
    log: log.with(BOUND),
    maxToolCallsPerMinute: limit,
    now: () => clock.now,
    service: 'stub',
    upstream: service.factory,
  });
  relays.push(relay);
  const delivered: JSONRPCMessage[] = [];
  const openSession = (): GrantSession & { ended: boolean } => {
    const session = {
      activity: 0,
      deliver: (message: JSONRPCMessage) => delivered.push(message),
      end: () => undefined,
      ended: false,
      given: undefined,
    };
    relay.admit(session, 64);
    return session;
  };
  const session = openSession();
  let nextId = 0;
  // Sends a tools/call at `atMs` on the test's clock and returns its id.
  const call = async (atMs: number, on: GrantSession = session) => {
    clock.now = atMs;
    nextId += 1;
    relay.forward(on, {
      id: nextId,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'echo' },
    });
    await settle();
    return nextId;
  };
  const answerTo = (id: RequestId) =>
    delivered.find((message) => 'id' in message && message.id === id);
  // The refusal this limit gave request `id`, or undefined.
  const refusalTo = (id: RequestId) => {
    const answer = answerTo(id);
    return answer !== undefined && 'result' in answer && answer.result.isError === true
      ? answer.result
      : undefined;
  };
  return {
    answerTo,
    call,
    clock,
    info: () => entries.filter((entry) => entry.level === 'info'),
    openSession,
    refusalTo,
    relay,
    service,
    session,
    warnings: () => entries.filter((entry) => entry.level === 'warn'),
  };
};

describe('counting', () => {
  test('a call counts when it is handed to the Service, and a call past the limit is not sent', async () => {
    const { call, refusalTo, service } = fixture({ limit: 2 });

    const first = await call(0);
    const second = await call(10 * SECOND);
    const third = await call(10.5 * SECOND);

    expect(service.sentTools().map((message) => message.params?.name)).toEqual(['echo', 'echo']);
    expect(refusalTo(first)).toBeUndefined();
    expect(refusalTo(second)).toBeUndefined();
    expect(refusalTo(third)).toBeDefined();
  });

  test('a refused call does not count', async () => {
    const { call, refusalTo, service } = fixture({ limit: 1 });

    await call(0);
    expect(refusalTo(await call(30 * SECOND))).toBeDefined();
    // Had the refusal counted, it would still be in the window.
    expect(refusalTo(await call(60 * SECOND + 1))).toBeUndefined();
    expect(service.sentTools()).toHaveLength(2);
  });

  test('only tools/call counts', async () => {
    const { call, refusalTo, relay, service, session } = fixture({ limit: 1 });

    for (const [id, method] of [
      [101, 'tools/list'],
      [102, 'resources/list'],
      [103, 'prompts/get'],
    ] as const) {
      relay.forward(session, { id, jsonrpc: '2.0', method });
    }
    await settle();

    expect(refusalTo(await call(1))).toBeUndefined();
    expect(service.sentTools()).toHaveLength(1);
  });

  test("a call refused for ADR-0002's request limit does not count", async () => {
    const { call, refusalTo, answerTo, service } = fixture({
      limit: 2,
      limits: { requestsPerGrant: 1 },
    });
    service.control.holding = true;

    await call(0);
    const overLimit = await call(SECOND);
    expect(answerTo(overLimit)).toMatchObject({
      error: { message: ERRORS.tooManyRequests.message },
    });
    service.answerHeld();
    service.control.holding = false;

    expect(refusalTo(await call(2 * SECOND))).toBeUndefined();
    expect(service.sentTools()).toHaveLength(2);
  });

  test('a call from an ended Session, or one whose Session ends while it waits, does not count', async () => {
    const { call, openSession, refusalTo, relay, service } = fixture({ limit: 1 });
    const ended = openSession();
    ended.ended = true;
    await call(0, ended);

    const gate = Promise.withResolvers<void>();
    service.control.startGate = gate.promise;
    const leaving = openSession();
    await call(SECOND, leaving);
    relay.release(leaving);
    gate.resolve();
    await settle();

    expect(refusalTo(await call(2 * SECOND))).toBeUndefined();
    expect(service.sentTools()).toHaveLength(1);
  });

  test('a call that fails after it is handed over still counts', async () => {
    const { call, refusalTo, service } = fixture({ limit: 1 });
    service.control.holding = true;

    await call(0);
    service.runs[0]?.crash();
    await settle();
    service.control.holding = false;

    expect(refusalTo(await call(SECOND))).toBeDefined();
  });

  test('a call that is cancelled after it is handed over still counts', async () => {
    const { call, refusalTo, relay, service, session } = fixture({ limit: 1 });
    service.control.holding = true;

    const cancelled = await call(0);
    relay.cancel(session, cancelled, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: cancelled },
    });
    await settle();
    service.control.holding = false;

    expect(refusalTo(await call(SECOND))).toBeDefined();
  });

  test('a call that fails because its Service could not start does not count', async () => {
    const { answerTo, call, refusalTo, service } = fixture({
      limit: 1,
      limits: { backoffBaseMs: 1, backoffMaxMs: 1 },
    });
    service.control.failStarts = 1;

    const failed = await call(0);
    expect(answerTo(failed)).toMatchObject({ error: {} });
    // Let the 1 ms backoff pass on the relay's own clock.
    await Bun.sleep(5);

    expect(refusalTo(await call(SECOND))).toBeUndefined();
    expect(service.sentTools()).toHaveLength(1);
  });

  for (const [kind, restartsAtOnce] of [
    ['Child', false],
    ['Link', true],
  ] as const) {
    test(`the window outlives a ${kind} that stops and starts again`, async () => {
      const { call, refusalTo, service } = fixture({ limit: 1, restartsAtOnce });

      await call(0);
      service.runs[0]?.crash();
      await settle();

      expect(refusalTo(await call(30 * SECOND))).toBeDefined();
      expect(service.runs).toHaveLength(2);
      expect(refusalTo(await call(60 * SECOND + 1))).toBeUndefined();
    });
  }
});

describe('the refusal', () => {
  test('is a tool result with isError, one text block, and the wait in _meta', async () => {
    const { answerTo, call } = fixture({ limit: 2 });

    await call(0);
    await call(10 * SECOND);
    const refused = await call(10.5 * SECOND);

    expect(answerTo(refused)).toEqual({
      id: refused,
      jsonrpc: '2.0',
      result: {
        _meta: { 'com.dbtlr.modgud/retryAfterSeconds': 50 },
        content: [
          {
            text: 'Rate limit reached: the limit is 2 tool calls per minute. Try again in 50 seconds.',
            type: 'text',
          },
        ],
        isError: true,
      },
    });
  });

  test('says "tool call" for a limit of 1 and "second" for a wait of 1', async () => {
    const { call, refusalTo } = fixture({ limit: 1 });

    await call(0);

    expect(refusalTo(await call(59.2 * SECOND))?.content).toEqual([
      {
        text: 'Rate limit reached: the limit is 1 tool call per minute. Try again in 1 second.',
        type: 'text',
      },
    ]);
  });

  test('rounds the wait up to whole seconds', async () => {
    const { call, refusalTo } = fixture({ limit: 1 });
    const waitAt = async (atMs: number) =>
      (await call(atMs).then(refusalTo))?._meta?.['com.dbtlr.modgud/retryAfterSeconds'];

    await call(0);

    expect(await waitAt(1)).toBe(60);
    expect(await waitAt(58 * SECOND)).toBe(2);
    expect(await waitAt(58 * SECOND + 1)).toBe(2);
    // 1.4 seconds: rounding to the nearest second would say 1.
    expect(await waitAt(58.6 * SECOND)).toBe(2);
    expect(await waitAt(59 * SECOND)).toBe(1);
    expect(await waitAt(60 * SECOND - 1)).toBe(1);
  });
});

// The warnings that start an episode.
const started = (entries: LogEntry[]) => entries.filter((entry) => entry.message === LIMIT_REACHED);

describe('episode logging', () => {
  test('logs one warning when refusals start and one count when they end', async () => {
    const { call, info, warnings } = fixture({ limit: 1 });

    await call(0);
    await call(10 * SECOND);
    await call(20 * SECOND);
    expect(warnings()).toEqual([
      {
        fields: { ...BOUND, limit: 1 },
        level: 'warn',
        message: LIMIT_REACHED,
      },
    ]);
    expect(info()).toEqual([]);

    // Sent, but within 60 seconds of the last refusal: the episode goes on.
    await call(70 * SECOND);
    expect(info()).toEqual([]);

    // The first call sent after a full 60 seconds without a refusal ends it.
    await call(140 * SECOND);
    expect(info()).toEqual([episodeEnd(2)]);
    expect(warnings()).toHaveLength(1);
  });

  test('a call sent exactly 60 seconds after the last refusal ends the episode, and one sent sooner does not', async () => {
    const sentAfter = async (quietMs: number) => {
      const { call, info } = fixture({ limit: 1 });
      await call(0);
      await call(10 * SECOND);
      // The call at 0 has left the window, so this one is sent.
      await call(10 * SECOND + quietMs);
      return info();
    };

    expect(await sentAfter(60 * SECOND - 1)).toEqual([]);
    expect(await sentAfter(60 * SECOND)).toEqual([episodeEnd(1)]);
  });

  test('a Caller that calls without pause at the limit costs two lines per episode, at least 60 seconds apart', async () => {
    const { call, info, warnings } = fixture({ limit: 2 });

    // Calls every 20 seconds against a limit of 2 per minute: each third call
    // is refused, then the next one fits as the oldest leaves the window.
    for (let at = 0; at <= 600 * SECOND; at += 20 * SECOND) {
      // oxlint-disable-next-line no-await-in-loop -- the calls are made in order on the clock
      await call(at);
    }
    expect(started(warnings())).toHaveLength(1);
    expect(info()).toEqual([]);

    await call(700 * SECOND);
    expect(started(warnings())).toHaveLength(1);
    expect(info()).toHaveLength(1);
    // Refused at 40, 100, ..., 580 seconds: every third call, 10 in all.
    expect(info()).toEqual([episodeEnd(10)]);

    // A refusal right after the episode ended starts the next one, which is
    // at least 60 seconds after the last one started.
    await call(700 * SECOND + 1);
    await call(700 * SECOND + 2);
    expect(started(warnings())).toHaveLength(2);
  });

  test('a call refused for another reason neither starts nor ends an episode', async () => {
    const { call, info, relay, service, session, warnings } = fixture({
      limit: 1,
      limits: { requestsPerGrant: 1 },
    });
    service.control.holding = true;

    await call(0);
    // Refused for ADR-0002's request limit: one request is open.
    await call(SECOND);
    expect(started(warnings())).toEqual([]);
    service.answerHeld();
    service.control.holding = false;

    // Now an episode: refused for this limit.
    await call(2 * SECOND);
    expect(started(warnings())).toHaveLength(1);

    // After a quiet minute, a refusal for the request limit does not end it.
    service.control.holding = true;
    relay.forward(session, { id: 'held-list', jsonrpc: '2.0', method: 'tools/list' });
    await call(70 * SECOND);
    expect(info()).toEqual([]);
    service.answerHeld();
    service.control.holding = false;

    // The first call handed over ends it, counting only this limit's refusal.
    await call(71 * SECOND);
    expect(info()).toEqual([episodeEnd(1)]);
    expect(started(warnings())).toHaveLength(1);
  });

  for (const kind of ['grant ended', 'shutdown'] as const) {
    test(`an episode ends with its count when the relay ends for ${kind}`, async () => {
      const { call, info, relay } = fixture({ limit: 1 });

      await call(0);
      await call(SECOND);
      await call(2 * SECOND);
      await call(3 * SECOND);
      await relay.end(kind);

      expect(info()).toEqual([episodeEnd(3)]);
    });
  }

  test('a relay that ends outside an episode logs no count', async () => {
    const { call, info, relay } = fixture({ limit: 1 });

    await call(0);
    await relay.end('shutdown');

    expect(info()).toEqual([]);
  });
});
