// ADR-0002's request limit: refusals are logged as episodes, as the tool call
// limit's are. Each test drives a real GrantRelay over a Service that holds
// its answers back, so requests stay open, and a clock the test moves.
import { afterEach, describe, expect, test } from 'bun:test';

import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/server';

import { GRANT_LIMITS, GrantRelay } from './grant-relay.ts';
import type { GrantSession } from './grant-relay.ts';
import { createLogRecorder } from './testing/log-recorder.ts';
import type { LogEntry } from './testing/log-recorder.ts';
import type { Upstream, UpstreamEvents } from './upstream.ts';

const SECOND = 1000;
const OPEN_LIMIT = 2;

const BOUND = { grant: 'static-token', service: 'stub', upstream: 'child' };
const REFUSED = '{service} {upstream} for {grant} refused a request: {limit} are open.';

// The entry that ends an episode that refused `refused` requests.
const episodeEnd = (refused: number): LogEntry => ({
  fields: { ...BOUND, refused },
  level: 'info',
  message:
    '{service} {upstream} for {grant} ended a request limit episode, refusing requests: {refused}.',
});

const relays: GrantRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map(async (relay) => relay.end('shutdown')));
});

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- let each queued step run in turn
    await Bun.sleep(0);
  }
};

const fixture = ({ maxToolCallsPerMinute = 1000 } = {}) => {
  const clock = { now: 0 };
  const held: { events: UpstreamEvents; id: RequestId }[] = [];
  const upstream = (events: UpstreamEvents): Upstream => {
    const stopped = Promise.withResolvers<void>();
    return {
      answer: () => undefined,
      cancel: () => undefined,
      request: (message) => {
        held.push({ events, id: message.id });
      },
      restartsAtOnce: false,
      start: async () => ({
        kind: 'started',
        result: { capabilities: { tools: {} }, protocolVersion: '2025-11-25', serverInfo: {} },
      }),
      stop: () => stopped.resolve(),
      stopped: stopped.promise,
      workOutlivesStop: false,
    };
  };
  const { entries, log } = createLogRecorder();
  const relay = new GrantRelay({
    grant: 'static-token',
    idleTimeoutMs: 60 * 60 * SECOND,
    limits: { ...GRANT_LIMITS, requestsPerGrant: OPEN_LIMIT },
    log: log.with(BOUND),
    maxToolCallsPerMinute,
    now: () => clock.now,
    service: 'stub',
    upstream,
  });
  relays.push(relay);
  const delivered: JSONRPCMessage[] = [];
  const session: GrantSession = {
    activity: 0,
    deliver: (message: JSONRPCMessage) => delivered.push(message),
    end: () => undefined,
    ended: false,
    given: undefined,
  };
  relay.admit(session, 64);
  let nextId = 0;
  // Sends a request at `atMs` on the test's clock.
  const send = async (atMs: number, method = 'tools/list') => {
    clock.now = atMs;
    nextId += 1;
    relay.forward(
      session,
      method === 'tools/call'
        ? { id: nextId, jsonrpc: '2.0', method, params: { name: 'echo' } }
        : { id: nextId, jsonrpc: '2.0', method },
    );
    await settle();
  };
  // Answers every request held, so none counts against the limit.
  const answerHeld = async () => {
    for (const { events, id } of held.splice(0)) {
      events.onMessage({ id, jsonrpc: '2.0', result: { tools: [] } });
    }
    await settle();
  };
  return {
    answerHeld,
    info: () => entries.filter((entry) => entry.level === 'info'),
    relay,
    send,
    warnings: () => entries.filter((entry) => entry.level === 'warn'),
  };
};

describe('request limit episode logging', () => {
  test('logs one warning for many refusals and one count when a request is admitted after a quiet minute', async () => {
    const { answerHeld, info, send, warnings } = fixture();

    await send(0);
    await send(SECOND);
    for (let refusal = 0; refusal < 10; refusal += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the requests are sent in order on the clock
      await send(2 * SECOND + refusal);
    }
    expect(warnings()).toEqual([
      { fields: { ...BOUND, limit: OPEN_LIMIT }, level: 'warn', message: REFUSED },
    ]);
    expect(info()).toEqual([]);

    // Forwarded, but within 60 seconds of the last refusal: the episode goes on.
    await answerHeld();
    await send(30 * SECOND);
    expect(info()).toEqual([]);

    await answerHeld();
    await send(100 * SECOND);
    expect(info()).toEqual([episodeEnd(10)]);
    expect(warnings()).toHaveLength(1);
  });

  test('a refusal after an episode ended starts a new one', async () => {
    const { answerHeld, info, send, warnings } = fixture();

    await send(0);
    await send(SECOND);
    await send(2 * SECOND);
    await answerHeld();
    await send(70 * SECOND);
    expect(info()).toEqual([episodeEnd(1)]);

    await send(71 * SECOND);
    await send(72 * SECOND);
    expect(warnings()).toHaveLength(2);
  });

  for (const kind of ['grant ended', 'shutdown'] as const) {
    test(`an episode ends with its count when the relay ends for ${kind}`, async () => {
      const { info, relay, send } = fixture();

      await send(0);
      await send(SECOND);
      await send(2 * SECOND);
      await send(3 * SECOND);
      await relay.end(kind);

      expect(info()).toEqual([episodeEnd(2)]);
    });
  }

  test('a refusal long after the last one continues the episode, which only an admitted request ends', async () => {
    const { answerHeld, info, send, warnings } = fixture();

    await send(0);
    await send(SECOND);
    await send(2 * SECOND);
    await send(100 * SECOND);
    expect(info()).toEqual([]);
    expect(warnings()).toHaveLength(1);

    await answerHeld();
    await send(200 * SECOND);
    expect(info()).toEqual([episodeEnd(2)]);
  });

  test('a request the limit admits ends the episode even when the tool call limit then refuses it', async () => {
    const { answerHeld, info, send, warnings } = fixture({ maxToolCallsPerMinute: 1 });

    await send(0);
    await send(SECOND);
    await send(2 * SECOND);
    await answerHeld();
    // Within the episode: forwarded, and it takes the minute's one tool call.
    await send(30 * SECOND, 'tools/call');
    await answerHeld();
    expect(info()).toEqual([]);

    // A quiet minute after the refusal, the request limit admits this call,
    // and the tool call limit refuses it.
    await send(80 * SECOND, 'tools/call');
    expect(info()).toEqual([episodeEnd(1)]);
    expect(warnings().map((entry) => entry.message)).toEqual([
      REFUSED,
      '{service} {upstream} for {grant} refused a tool call: the Grant reached its tool call limit of {limit} per minute.',
    ]);
  });

  test('a relay that ends outside an episode logs no count', async () => {
    const { info, relay, send } = fixture();

    await send(0);
    await relay.end('shutdown');

    expect(info()).toEqual([]);
  });
});
