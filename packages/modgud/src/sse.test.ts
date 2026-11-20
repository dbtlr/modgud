import { expect, test } from 'bun:test';

import { eventData } from './sse.ts';

const streamOf = (text: string) => new Response(text).body as ReadableStream<Uint8Array>;

const events = async (text: string, maxBytes = 1024 * 1024) => {
  const found: string[] = [];
  for await (const event of eventData(streamOf(text), maxBytes)) {
    found.push(event);
  }
  return found;
};

test("joins an event's data lines with LF, empty lines included", async () => {
  expect(await events('data: a\ndata\ndata:b\n\n')).toEqual(['a\n\nb']);
});

test('skips an event whose only data line is empty, but not one with two', async () => {
  expect(await events('data\n\ndata\ndata\n\n')).toEqual(['\n']);
});

test('ignores comments, event names, ids, and retry fields', async () => {
  expect(await events(': hi\nevent: message\nid: 7\nretry: 10\ndata: x\n\n')).toEqual(['x']);
});

test('holds many short data lines as one event within the byte bound', async () => {
  const lines = 200_000;
  const [event] = await events(`${'data:\n'.repeat(lines)}\n`, 10 * 1024 * 1024);

  expect(event).toBe('\n'.repeat(lines - 1));
});
