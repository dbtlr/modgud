import { expect, test } from 'bun:test';

import type { GrantRelay } from './grant-relay.ts';
import { initializeAnswer } from './protocol.ts';
import { Session } from './session.ts';
import { createLogRecorder } from './testing/log-recorder.ts';
import type { LogEntry } from './testing/log-recorder.ts';

const URL_ = 'http://127.0.0.1/stub/mcp';
const VERSION = '2025-11-25';

// A Session over a Child that is never asked for anything: the test only
// opens it, opens GET streams, and delivers notifications to it.
const openSession = async () => {
  const { entries, log } = createLogRecorder();
  const child = { release: () => [] } as unknown as GrantRelay;
  const session = new Session({
    child,
    grant: 'grant',
    idleMs: 60_000,
    log,
    onEnd: () => undefined,
    service: 'stub',
  });
  const body = {
    id: 0,
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
      protocolVersion: VERSION,
    },
  };
  const opened = await session.open(
    new Request(URL_, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }),
    body,
    initializeAnswer(VERSION, {
      capabilities: { tools: { listChanged: true } },
      protocolVersion: VERSION,
      serverInfo: { name: 'stub', version: '1' },
    }),
  );
  await opened.text();
  return { entries, session };
};

const openGet = async (session: Session) => {
  const response = await session.handle(
    new Request(URL_, {
      headers: {
        Accept: 'text/event-stream',
        'Mcp-Protocol-Version': VERSION,
        'Mcp-Session-Id': session.id,
      },
      method: 'GET',
    }),
  );
  expect(response.status).toBe(200);
  return response;
};

// A notification for the GET stream carrying 256 KiB.
const quarterMiB = {
  jsonrpc: '2.0' as const,
  method: 'notifications/tools/list_changed',
  params: { padding: 'p'.repeat(256 * 1024) },
};

const overflowed = (entries: LogEntry[]) =>
  entries.filter(
    (entry) =>
      entry.message ===
      '{service} session {session} ended a stream its Caller stopped reading, with more than {limit} MiB unsent.',
  );

test('a GET stream holding more than 1 MiB unread ends on the next message, and the Session stays open', async () => {
  const { entries, session } = await openSession();
  await openGet(session);
  // Four quarter-MiB events, framing included, come to just over 1 MiB held.
  for (let index = 0; index < 4; index += 1) {
    session.deliver(quarterMiB, { activity: false });
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    await Bun.sleep(5);
  }
  expect(overflowed(entries)).toEqual([]);
  session.deliver(quarterMiB, { activity: false });
  await Bun.sleep(5);
  // The event carries the fields the Session bound, and its own limit.
  expect(overflowed(entries).map((entry) => entry.fields)).toEqual([
    { limit: 1, service: 'stub', session: session.id.slice(0, 8) },
  ]);
  expect(session.ended).toBe(false);

  // The Caller can open a new GET stream, and it carries notifications.
  const reopened = await openGet(session);
  session.deliver(
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    { activity: false },
  );
  const reader = reopened.body!.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain('notifications/tools/list_changed');
  await reader.cancel();
  session.end('deleted');
});
