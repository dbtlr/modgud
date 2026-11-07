import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  createHarness,
  openRawSession,
  post,
  requestOn,
  toolCall,
  waitFor,
} from './testing/listener-harness.ts';

const harness = createHarness();
beforeEach(harness.setup);
afterEach(harness.teardown);

// Guards against GrantChild.cancel matching in-flight entries by caller id alone.
test("a Session cannot cancel another Session's in-flight request by reusing its id", async () => {
  const { lines, url } = await harness.start();
  const owner = await openRawSession(url);
  const intruder = await openRawSession(url);
  const stream = requestOn(url, owner.headers, toolCall('caller-id', 'wait-for-cancel'));
  let childId: string | undefined;
  await waitFor(() => {
    childId = lines.map((l) => / stderr: waiting for cancel (.+)$/u.exec(l)?.[1]).find(Boolean);
    return childId !== undefined;
  });
  const sent = await post(
    url,
    intruder.headers,
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'caller-id' },
    }),
  );
  expect(sent.status).toBe(202);
  await Bun.sleep(300);
  expect(lines).not.toContain(`stub child for static-token stderr: cancelled ${childId}`);
  void stream;
});

// Guards against GrantChild.cancel dropping waiting entries by caller id alone.
test("a Session cannot drop another Session's waiting request by reusing its id", async () => {
  const { lines, listener, url } = await harness.start({
    idleMinutes: 0.005,
    stubEnv: { STUB_COUNTER: `${harness.directory}/starts`, STUB_MODE: ',mute' },
  });
  const owner = await openRawSession(url);
  const intruder = await openRawSession(url);
  await waitFor(() => lines.some((l) => l.endsWith(' stopped: idle.')));
  const stream = requestOn(url, owner.headers, toolCall(9, 'echo', { text: 'mine' }));
  await waitFor(() => lines.filter((l) => / started, pid /u.test(l)).length === 2);
  const sent = await post(
    url,
    intruder.headers,
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }),
  );
  expect(sent.status).toBe(202);
  await listener.close();
  // Still waiting, so shutdown answers it with the session-ended error.
  expect((await stream).messages).toEqual([
    { error: { code: -32_603, message: 'The session ended' }, id: 9, jsonrpc: '2.0' },
  ]);
});

// Guards against #fromChild not restarting the idle clock.
test("a Child's progress messages keep it from idling out during a long call", async () => {
  const { url } = await harness.start({ idleMinutes: 0.005 }); // 300 ms
  const { headers } = await openRawSession(url);
  const { messages } = await requestOn(url, headers, {
    id: 1,
    method: 'tools/call',
    params: { _meta: { progressToken: 't' }, arguments: {}, name: 'progress-ticks' },
  });
  expect(messages.at(-1)).toMatchObject({ id: 1, result: { content: [{ text: 'done' }] } });
});

// Guards against a response not counting as its Session's activity.
test('a response is activity, so eviction spares the Session it answered', async () => {
  const { url } = await harness.start({ maxSessionsPerGrant: 2 });
  const answered = await openRawSession(url);
  const other = await openRawSession(url);
  const slow = requestOn(url, answered.headers, toolCall(1, 'slow', { ms: 400 }));
  await Bun.sleep(100);
  await requestOn(url, other.headers, { id: 2, method: 'tools/list' });
  await slow; // the response arrives after other's last request
  await openRawSession(url);
  expect((await requestOn(url, answered.headers, { id: 3, method: 'tools/list' })).status).toBe(
    200,
  );
  expect((await requestOn(url, other.headers, { id: 4, method: 'tools/list' })).status).toBe(404);
});
