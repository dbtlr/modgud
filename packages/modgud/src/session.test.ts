import { expect, test } from 'bun:test';

import type { GrantChild } from './grant-child.ts';
import { initializeAnswer } from './protocol.ts';
import { Session } from './session.ts';

const URL_ = 'http://127.0.0.1/stub/mcp';
const VERSION = '2025-11-25';

// A Session over a Child that is never asked for anything: the test only
// opens it, opens GET streams, and delivers notifications to it.
const openSession = async () => {
  const lines: string[] = [];
  const child = { release: () => [] } as unknown as GrantChild;
  const session = new Session({
    child,
    grant: 'grant',
    idleMs: 60_000,
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
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
  return { lines, session };
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

const overflowed = (lines: string[]) => lines.filter((line) => line.includes('stopped reading'));

test('a GET stream holding more than 1 MiB unread ends on the next message, and the Session stays open', async () => {
  const { lines, session } = await openSession();
  await openGet(session);
  // Four quarter-MiB events, framing included, come to just over 1 MiB held.
  for (let index = 0; index < 4; index += 1) {
    session.deliver(quarterMiB, { activity: false });
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    await Bun.sleep(5);
  }
  expect(overflowed(lines)).toEqual([]);
  session.deliver(quarterMiB, { activity: false });
  await Bun.sleep(5);
  expect(overflowed(lines)).toHaveLength(1);
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
