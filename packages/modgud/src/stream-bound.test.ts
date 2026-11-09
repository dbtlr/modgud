import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  createHarness,
  openRawSession,
  requestOn,
  toolCall,
  waitFor,
} from './testing/listener-harness.ts';

const harness = createHarness();
beforeEach(harness.setup);
afterEach(harness.teardown);

// Sends one request over a raw socket that never reads what comes back, as a
// Caller that stops reading its stream does.
const sendWithoutReading = async (url: URL, headers: Record<string, string>, body: string) => {
  const socket = await Bun.connect({
    hostname: url.hostname,
    port: Number(url.port),
    socket: {
      data: () => undefined,
      open: (opened) => {
        opened.pause();
      },
    },
  });
  const head = [
    `POST ${url.pathname} HTTP/1.1`,
    `Host: ${url.host}`,
    'Accept: application/json, text/event-stream',
    'Content-Type: application/json',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${head.join('\r\n')}\r\n\r\n${body}`);
  return socket;
};

test('a stream its Caller stops reading is ended, and the Grant keeps serving', async () => {
  const { lines, url } = await harness.start();
  const stalled = await openRawSession(url);
  const bystander = await openRawSession(url);
  // Far more than the HTTP connection's buffers take before Modgud holds the rest.
  const flood = {
    id: 1,
    method: 'tools/call',
    params: { _meta: { progressToken: 'flood' }, arguments: { count: 64 }, name: 'flood' },
  };
  const socket = await sendWithoutReading(
    url,
    stalled.headers,
    JSON.stringify({ jsonrpc: '2.0', ...flood }),
  );
  try {
    await waitFor(() => lines.some((line) => line.includes('stopped reading')), 20_000);
    const answer = await requestOn(url, bystander.headers, toolCall(2, 'echo', { text: 'still' }));
    expect(JSON.stringify(answer.messages)).toContain('still');
  } finally {
    socket.terminate();
  }
}, 30_000);
