// Integration tests of ADR-0002's shared Child: one on-demand Child per
// Grant, shared by the Grant's Sessions, which outlive it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  childStarts,
  connect,
  connectOAuthClient,
  createHarness,
  firstText,
  isAlive,
  openRawSession,
  inBackground,
  post,
  rejectionOf,
  processesWith,
  requestOn,
  toolCall,
  waitFor,
} from './testing/listener-harness.ts';

const harness = createHarness();
const { start } = harness;
beforeEach(harness.setup);
afterEach(harness.teardown);

// The messages the stub received, from its `STUB_TRACE` stderr lines.
const received = (lines: string[]) =>
  lines.flatMap((line) => {
    const match = / stderr: received (.*)$/u.exec(line);
    return match?.[1] === undefined ? [] : [JSON.parse(match[1]) as Record<string, unknown>];
  });

const stoppedLine = (lines: string[], reason: string) =>
  lines.some((line) => line.endsWith(` stopped: ${reason}.`));

const sessionEnded = { code: -32_603, message: 'The session ended' };
const methodNotFound = { code: -32_601, message: 'Method not found' };

// A start counter for a stub that runs a different mode on each start.
const counterFile = () => join(harness.directory, `starts-${crypto.randomUUID()}`);

const callPid = async (client: Awaited<ReturnType<typeof connect>>['client']) =>
  firstText(await client.callTool({ arguments: {}, name: 'pid' }));

const versionOf = async (url: URL, protocolVersion: string) =>
  (await openRawSession(url, { protocolVersion })).result.protocolVersion;

// The error a request past the Grant's request limit gets.
const tooMany = (id: number) => [
  {
    error: { code: -32_000, message: 'Too many requests are open for this Grant' },
    id,
    jsonrpc: '2.0',
  },
];

// Starts a call that waits to be cancelled, and returns its stream and the
// id the Child knows it by.
const waitForCancel = async (
  lines: string[],
  url: URL,
  headers: Record<string, string>,
): Promise<{ childId: string; stream: ReturnType<typeof requestOn> }> => {
  const stream = requestOn(url, headers, toolCall('caller-id', 'wait-for-cancel'));
  let childId: string | undefined;
  await waitFor(() => {
    childId = lines
      .map((line) => / stderr: waiting for cancel (.+)$/u.exec(line)?.[1])
      .find((id) => id !== undefined);
    return childId !== undefined;
  });
  return { childId: childId ?? '', stream };
};

describe('sharing', () => {
  test("two Sessions of one Grant share one Child, and another Grant's Sessions get their own", async () => {
    const { lines, store, url } = await start();
    const { accessToken } = connectOAuthClient(store);
    const first = await connect(url);
    const second = await connect(url);
    const oauth = await connect(url, { token: accessToken });

    const [firstPid, secondPid, oauthPid] = await Promise.all(
      [first, second, oauth].map(async ({ client }) => callPid(client)),
    );

    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    expect(firstPid).toMatch(/^\d+$/u);
    expect(secondPid).toBe(firstPid);
    expect(oauthPid).not.toBe(firstPid);
    expect(childStarts(lines)).toHaveLength(2);
  });
});

describe('renumbering', () => {
  test('two Sessions that use the same request id and progress token each get only their own messages', async () => {
    const { url } = await start();
    const first = await openRawSession(url);
    const second = await openRawSession(url);
    const call = async (headers: Record<string, string>, text: string) =>
      requestOn(url, headers, {
        id: 7,
        method: 'tools/call',
        params: { _meta: { progressToken: 'shared' }, arguments: { text }, name: 'progress-echo' },
      });

    const [firstStream, secondStream] = await Promise.all([
      call(first.headers, 'first'),
      call(second.headers, 'second'),
    ]);

    for (const [stream, text] of [
      [firstStream, 'first'],
      [secondStream, 'second'],
    ] as const) {
      expect(stream.messages).toMatchObject([
        {
          method: 'notifications/progress',
          params: { message: text, progress: 1, progressToken: 'shared', total: 1 },
        },
        { id: 7, result: { content: [{ text, type: 'text' }] } },
      ]);
    }
  });
});

describe('initialize', () => {
  test("is answered from the Child's stored result, and the Caller's notifications/initialized never reaches the Child", async () => {
    const { lines, url } = await start({ stubEnv: { STUB_TRACE: '1' } });
    await connect(url);
    await connect(url);

    const { result } = await openRawSession(url);

    await Bun.sleep(100);
    const methods = received(lines).map((message) => message.method);
    expect(methods.filter((method) => method === 'initialize')).toHaveLength(1);
    expect(methods.filter((method) => method === 'notifications/initialized')).toHaveLength(1);
    expect(received(lines)[0]).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'modgud', version: '0.0.0' },
        protocolVersion: '2025-11-25',
      },
    });
    expect(result).toMatchObject({ serverInfo: { name: 'stub-service', version: '1.0.0' } });
  });

  test('hides tasks and resource subscriptions from the capabilities', async () => {
    const { url } = await start({
      stubEnv: {
        STUB_CAPABILITIES: JSON.stringify({
          resources: { listChanged: true, subscribe: true },
          tasks: { list: {} },
          tools: {},
        }),
        STUB_MODE: 'raw',
      },
    });

    const { result } = await openRawSession(url);

    expect(result.capabilities).toEqual({ resources: { listChanged: true }, tools: {} });
  });

  test("gives the Caller's version when Modgud supports it and it is no newer than the Child's, otherwise the Child's", async () => {
    const current = await start();
    const older = await start({ stubEnv: { STUB_MODE: 'raw', STUB_VERSION: '2025-06-18' } });

    expect(await versionOf(current.url, '2025-06-18')).toBe('2025-06-18');
    expect(await versionOf(current.url, '2025-11-25')).toBe('2025-11-25');
    expect(await versionOf(current.url, '2026-07-28')).toBe('2025-11-25');
    expect(await versionOf(older.url, '2025-11-25')).toBe('2025-06-18');
  });
});

describe('eviction', () => {
  test('at the limit, a new Session evicts the least recently active open one, which then gets 404', async () => {
    const { lines, listener, url } = await start({ maxSessionsPerGrant: 2 });
    const first = await openRawSession(url);
    const second = await openRawSession(url);
    await requestOn(url, first.headers, { id: 1, method: 'tools/list' });

    const third = await openRawSession(url);

    expect(listener.sessionCount()).toBe(2);
    expect(lines.filter((line) => line.endsWith('ended: evicted.'))).toHaveLength(1);
    expect((await requestOn(url, second.headers, { id: 2, method: 'tools/list' })).status).toBe(
      404,
    );
    expect((await requestOn(url, first.headers, { id: 3, method: 'tools/list' })).status).toBe(200);
    expect((await requestOn(url, third.headers, { id: 4, method: 'tools/list' })).status).toBe(200);
  });

  test('an initialize gets 503 only when every Session of the Grant is still opening', async () => {
    const { lines, listener, url } = await start({
      maxSessionsPerGrant: 1,
      stubEnv: { STUB_MODE: 'mute' },
    });
    const opening = post(url, { Authorization: 'Bearer harness-token' });
    await waitFor(() => childStarts(lines).length === 1);

    const refused = await post(url, { Authorization: 'Bearer harness-token' });

    expect(refused.status).toBe(503);
    await listener.close();
    expect((await opening).status).toBe(503);
  });
});

describe('a Child that idles out', () => {
  test('stops while its Sessions stay open, and the next request starts a new Child', async () => {
    const { lines, listener, url } = await start({ idleMinutes: 0.005 });
    const { client } = await connect(url);
    const firstPid = await callPid(client);

    await waitFor(() => stoppedLine(lines, 'idle'));
    await waitFor(() => !isAlive(Number(firstPid)));
    expect(listener.sessionCount()).toBe(1);

    const secondPid = await callPid(client);
    expect(secondPid).toMatch(/^\d+$/u);
    expect(secondPid).not.toBe(firstPid);
  });
});

describe('a Child that crashes', () => {
  test('fails the requests in flight with an error, and the Session survives', async () => {
    const { lines, listener, url } = await start({ childLimits: { backoffBaseMs: 100 } });
    const { client } = await connect(url);
    const firstPid = await callPid(client);

    expect(await rejectionOf(client.callTool({ arguments: {}, name: 'crash' }))).toContain(
      'The Service stopped before it answered',
    );

    expect(stoppedLine(lines, 'exited with status 1')).toBe(true);
    expect(listener.sessionCount()).toBe(1);
    await Bun.sleep(150);
    expect(await callPid(client)).not.toBe(firstPid);
  });

  test('backs off, doubling after consecutive failures, and a request during backoff fails at once', async () => {
    const { url } = await start({ childLimits: { backoffBaseMs: 300 } });
    const { client } = await connect(url);
    const crash = async () => {
      expect(await rejectionOf(client.callTool({ arguments: {}, name: 'crash' }))).toContain(
        'The Service stopped before it answered',
      );
    };

    await crash();
    const refusedAt = performance.now();
    expect(await rejectionOf(callPid(client))).toContain('The Service is unavailable');
    expect(performance.now() - refusedAt).toBeLessThan(200);
    await Bun.sleep(350);
    await crash();
    await Bun.sleep(350);
    expect(await rejectionOf(callPid(client))).toContain('The Service is unavailable');
    await Bun.sleep(350);
    expect(await callPid(client)).toMatch(/^\d+$/u);
  });

  test('forgets its failures once a Child has run long enough', async () => {
    const { url } = await start({ childLimits: { backoffBaseMs: 300, backoffResetMs: 100 } });
    const { client } = await connect(url);
    const crash = async () => {
      expect(await rejectionOf(client.callTool({ arguments: {}, name: 'crash' }))).toContain(
        'The Service stopped before it answered',
      );
    };

    await crash();
    await Bun.sleep(350);
    await callPid(client);
    await Bun.sleep(150);
    await crash();
    await Bun.sleep(350);

    expect(await callPid(client)).toMatch(/^\d+$/u);
  });

  test('a Child whose command cannot be started fails its initialize with 502, and backs off', async () => {
    const { lines, url } = await start({ command: '/nonexistent/modgud-test-service' });

    const failed = await post(url, { Authorization: 'Bearer harness-token' });
    const refused = await post(url, { Authorization: 'Bearer harness-token' });

    expect(failed.status).toBe(502);
    expect(refused.status).toBe(502);
    expect(childStarts(lines)).toHaveLength(0);
    expect(lines.some((line) => line.includes(' could not start: '))).toBe(true);
  });

  test('a Child that exits before answering initialize fails it with 502, and backs off', async () => {
    const { lines, url } = await start({ stubEnv: { STUB_MODE: 'exit' } });

    const failed = await post(url, { Authorization: 'Bearer harness-token' });
    const refused = await post(url, { Authorization: 'Bearer harness-token' });

    expect(failed.status).toBe(502);
    expect(refused.status).toBe(502);
    expect(stoppedLine(lines, 'exited with status 1')).toBe(true);
    expect(childStarts(lines)).toHaveLength(1);
  });
});

describe('revocation', () => {
  test('stops a Child that is still starting, and fails its initialize', async () => {
    const marker = `marker-${crypto.randomUUID()}`;
    const { lines, store, url } = await start({
      authorizationSweepMs: 20,
      marker,
      stubEnv: { STUB_MODE: 'mute' },
    });
    const { accessToken } = connectOAuthClient(store);
    const opening = post(url, { Authorization: `Bearer ${accessToken}` });
    await waitFor(() => childStarts(lines).length === 1);

    store.revokeAll();

    expect((await opening).status).toBe(401);
    expect(stoppedLine(lines, 'authorization ended')).toBe(true);
    await waitFor(async () => (await processesWith(marker)).length === 0);
  });

  test('a request waiting for a starting Child fails and is never forwarded', async () => {
    const { lines, store, url } = await start({
      authorizationSweepMs: 20,
      idleMinutes: 0.005,
      stubEnv: { STUB_COUNTER: counterFile(), STUB_MODE: ',mute', STUB_TRACE: '1' },
    });
    const { accessToken } = connectOAuthClient(store);
    const session = await openRawSession(url, { token: accessToken });
    await waitFor(() => stoppedLine(lines, 'idle'));
    const tracedBefore = received(lines).length;
    const waiting = requestOn(url, session.headers, toolCall(5, 'echo', { text: 'never' }));
    await waitFor(() => received(lines).length > tracedBefore);

    store.revokeAll();

    expect((await waiting).messages).toEqual([{ error: sessionEnded, id: 5, jsonrpc: '2.0' }]);
    expect(
      received(lines)
        .slice(tracedBefore)
        .map((message) => message.method),
    ).toEqual(['initialize']);
  });

  test('stops a Child whose Grant has no Sessions left', async () => {
    const { lines, listener, store, url } = await start({ authorizationSweepMs: 20 });
    const { accessToken } = connectOAuthClient(store);
    const { client, transport } = await connect(url, { token: accessToken });
    const pid = Number(await callPid(client));
    await transport.terminateSession();
    await waitFor(() => listener.sessionCount() === 0);
    expect(isAlive(pid)).toBe(true);

    store.revokeAll();

    await waitFor(() => !isAlive(pid));
    expect(stoppedLine(lines, 'authorization ended')).toBe(true);
  });
});

describe('a Session that ends with a request in flight', () => {
  test('on DELETE, Modgud cancels it on the Child by its renumbered id, the open request gets an error, and the Child keeps serving', async () => {
    const { lines, url } = await start();
    const ending = await openRawSession(url);
    const other = await openRawSession(url);
    const { childId, stream } = await waitForCancel(lines, url, ending.headers);

    const deleted = await fetch(url, { headers: ending.headers, method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect(childId).toMatch(/^\d+$/u);
    expect((await stream).messages).toEqual([
      { error: sessionEnded, id: 'caller-id', jsonrpc: '2.0' },
    ]);
    await waitFor(() => lines.includes(`stub child for static-token stderr: cancelled ${childId}`));
    const { messages } = await requestOn(url, other.headers, toolCall(1, 'echo', { text: 'on' }));
    expect(messages).toMatchObject([{ id: 1, result: { content: [{ text: 'on' }] } }]);
  });

  test('on eviction, Modgud cancels it on the Child, and the open request gets an error', async () => {
    const { lines, url } = await start({ maxSessionsPerGrant: 1 });
    const evicted = await openRawSession(url);
    const { childId, stream } = await waitForCancel(lines, url, evicted.headers);

    const newer = await openRawSession(url);

    expect((await stream).messages).toEqual([
      { error: sessionEnded, id: 'caller-id', jsonrpc: '2.0' },
    ]);
    await waitFor(() => lines.includes(`stub child for static-token stderr: cancelled ${childId}`));
    const { messages } = await requestOn(url, newer.headers, toolCall(1, 'echo', { text: 'on' }));
    expect(messages).toMatchObject([{ id: 1, result: { content: [{ text: 'on' }] } }]);
  });
});

describe('Caller requests Modgud answers itself', () => {
  test('ping and logging/setLevel get an empty result without starting a Child', async () => {
    const { lines, url } = await start({ idleMinutes: 0.005 });
    const { headers } = await openRawSession(url);
    await waitFor(() => stoppedLine(lines, 'idle'));

    const ping = await requestOn(url, headers, { id: 1, method: 'ping' });
    const setLevel = await requestOn(url, headers, {
      id: 2,
      method: 'logging/setLevel',
      params: { level: 'debug' },
    });

    expect(ping.messages).toEqual([{ id: 1, jsonrpc: '2.0', result: {} }]);
    expect(setLevel.messages).toEqual([{ id: 2, jsonrpc: '2.0', result: {} }]);
    await Bun.sleep(50);
    expect(childStarts(lines)).toHaveLength(1);
  });

  test('resource subscriptions and every tasks/ method get method not found', async () => {
    const { url } = await start();
    const { headers } = await openRawSession(url);

    const answers = await Promise.all(
      [
        { method: 'resources/subscribe', params: { uri: 'file:///x' } },
        { method: 'resources/unsubscribe', params: { uri: 'file:///x' } },
        { method: 'tasks/list' },
        { method: 'tasks/get', params: { taskId: 't' } },
      ].map(async (request, index) => requestOn(url, headers, { id: index, ...request })),
    );

    expect(answers.map(({ messages }) => messages)).toEqual(
      [0, 1, 2, 3].map((id) => [{ error: methodNotFound, id, jsonrpc: '2.0' }]),
    );
  });

  test('a request that asks to run as a task is forwarded as an ordinary request', async () => {
    const { lines, url } = await start({ stubEnv: { STUB_TRACE: '1' } });
    const { headers } = await openRawSession(url);

    const { messages } = await requestOn(url, headers, {
      id: 1,
      method: 'tools/call',
      params: { arguments: { text: 'plain' }, name: 'echo', task: { ttl: 60_000 } },
    });

    expect(messages).toMatchObject([{ id: 1, result: { content: [{ text: 'plain' }] } }]);
    const call = received(lines).find((message) => message.method === 'tools/call');
    expect(call?.params).toEqual({ arguments: { text: 'plain' }, name: 'echo' });
  });
});

describe('Child messages', () => {
  test("a Child's ping gets an empty result, and its sampling and elicitation requests get method not found", async () => {
    const { url } = await start();
    const { client } = await connect(url);
    const answer = async (method: string) =>
      JSON.parse(
        firstText(await client.callTool({ arguments: { method }, name: 'child-request' })) ?? '',
      ) as unknown;

    expect(await answer('ping')).toEqual({ id: 'stub-request-1', jsonrpc: '2.0', result: {} });
    expect(await answer('sampling/createMessage')).toEqual({
      error: methodNotFound,
      id: 'stub-request-2',
      jsonrpc: '2.0',
    });
    expect(await answer('elicitation/create')).toEqual({
      error: methodNotFound,
      id: 'stub-request-3',
      jsonrpc: '2.0',
    });
  });

  test("a Child's logging notification goes to the log and not to the Caller", async () => {
    const { lines, url } = await start();
    const { client } = await connect(url);
    const notified: unknown[] = [];
    client.setNotificationHandler('notifications/message', (notification) => {
      notified.push(notification);
    });

    await client.callTool({ arguments: { text: 'for the log\n' }, name: 'log' });

    await waitFor(() => lines.some((line) => line.includes('for the log')));
    expect(lines).toContainEqual(
      String.raw`stub child for static-token notification: {"jsonrpc":"2.0","method":"notifications/message","params":{"data":"for the log\n","level":"info"}}`,
    );
    expect(notified).toEqual([]);
  });

  test("tools/list_changed reaches every Session's GET stream, and is not activity", async () => {
    const { listener, url } = await start({ sessionIdleMinutes: 0.01 });
    const active = await connect(url);
    const quiet = await connect(url);
    const announced = { active: 0, quiet: 0 };
    active.client.setNotificationHandler('notifications/tools/list_changed', () => {
      announced.active += 1;
    });
    quiet.client.setNotificationHandler('notifications/tools/list_changed', () => {
      announced.quiet += 1;
    });
    await Bun.sleep(100);

    const deadline = performance.now() + 1500;
    while (listener.sessionCount() === 2 && performance.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- the active Session calls one at a time
      await active.client.callTool({ arguments: {}, name: 'list-changed' });
      // oxlint-disable-next-line no-await-in-loop -- paced on purpose
      await Bun.sleep(100);
    }

    expect(listener.sessionCount()).toBe(1);
    expect(announced.quiet).toBeGreaterThan(0);
    expect(announced.active).toBeGreaterThan(0);
    expect(
      firstText(await active.client.callTool({ arguments: { text: 'on' }, name: 'echo' })),
    ).toBe('on');
  });
});

describe('the request limit', () => {
  test('refuses a request past the limit, and a cancelled request keeps its slot until the hold passes', async () => {
    const { lines, url } = await start({
      childLimits: { cancelledHoldMs: 300, requestsPerGrant: 2 },
      stubEnv: { STUB_TRACE: '1' },
    });
    const { headers } = await openRawSession(url);
    for (const id of [1, 2]) {
      inBackground(requestOn(url, headers, toolCall(id, 'slow')));
    }
    await waitFor(
      () => received(lines).filter((message) => message.method === 'tools/call').length === 2,
    );

    expect((await requestOn(url, headers, toolCall(3, 'echo', { text: 'x' }))).messages).toEqual(
      tooMany(3),
    );
    const cancel = await post(
      url,
      headers,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    );
    expect(cancel.status).toBe(202);
    expect((await requestOn(url, headers, toolCall(4, 'echo', { text: 'x' }))).messages).toEqual(
      tooMany(4),
    );
    await Bun.sleep(350);
    expect(
      (await requestOn(url, headers, toolCall(5, 'echo', { text: 'x' }))).messages,
    ).toMatchObject([{ id: 5, result: { content: [{ text: 'x' }] } }]);
  });

  test('a cancelled request frees its slot once the Child answers it', async () => {
    const { lines, url } = await start({
      childLimits: { cancelledHoldMs: 10_000, requestsPerGrant: 1 },
      stubEnv: { STUB_TRACE: '1' },
    });
    const { headers } = await openRawSession(url);
    inBackground(requestOn(url, headers, toolCall(1, 'answer-despite-cancel', { ms: 300 })));
    await waitFor(() => received(lines).some((message) => message.method === 'tools/call'));
    await post(
      url,
      headers,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    );

    const refused = await requestOn(url, headers, toolCall(2, 'echo', { text: 'x' }));
    await Bun.sleep(400);
    const served = await requestOn(url, headers, toolCall(3, 'echo', { text: 'x' }));

    expect(refused.messages).toMatchObject([{ error: { code: -32_000 }, id: 2 }]);
    expect(served.messages).toMatchObject([{ id: 3, result: { content: [{ text: 'x' }] } }]);
  });

  test('a cancelled request frees its slot once the Child stops', async () => {
    const { lines, url } = await start({
      childLimits: { cancelledHoldMs: 10_000, requestsPerGrant: 1 },
      idleMinutes: 0.005,
      stubEnv: { STUB_TRACE: '1' },
    });
    const { headers } = await openRawSession(url);
    inBackground(requestOn(url, headers, toolCall(1, 'slow')));
    await waitFor(() => received(lines).some((message) => message.method === 'tools/call'));
    await post(
      url,
      headers,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    );
    const refused = await requestOn(url, headers, toolCall(2, 'echo', { text: 'x' }));

    await waitFor(() => stoppedLine(lines, 'idle'));
    const served = await requestOn(url, headers, toolCall(3, 'echo', { text: 'x' }));

    expect(refused.messages).toMatchObject([{ error: { code: -32_000 }, id: 2 }]);
    expect(served.messages).toMatchObject([{ id: 3, result: { content: [{ text: 'x' }] } }]);
  });
});

describe('the version gate', () => {
  test('a Child that answers with an unsupported protocol version is stopped and counts as a failure', async () => {
    const { lines, url } = await start({
      stubEnv: { STUB_MODE: 'raw', STUB_VERSION: '2024-11-05' },
    });

    const failed = await post(url, { Authorization: 'Bearer harness-token' });
    const backingOff = await post(url, { Authorization: 'Bearer harness-token' });

    expect(failed.status).toBe(502);
    expect(backingOff.status).toBe(502);
    expect(stoppedLine(lines, 'unsupported initialize result')).toBe(true);
    expect(childStarts(lines)).toHaveLength(1);
  });
});

describe('a changed Child', () => {
  test('ends every Session when the new Child gives other capabilities', async () => {
    const { lines, url } = await start({
      idleMinutes: 0.005,
      stubEnv: { STUB_COUNTER: counterFile(), STUB_MODE: ',raw' },
    });
    const first = await openRawSession(url);
    const second = await openRawSession(url);
    await waitFor(() => stoppedLine(lines, 'idle'));

    const waiting = await requestOn(url, first.headers, { id: 1, method: 'tools/list' });

    expect(waiting.messages).toEqual([{ error: sessionEnded, id: 1, jsonrpc: '2.0' }]);
    expect(lines.filter((line) => line.endsWith('ended: child changed.'))).toHaveLength(2);
    expect((await requestOn(url, second.headers, { id: 2, method: 'tools/list' })).status).toBe(
      404,
    );
  });

  test('ends only the Sessions given a version newer than the new Child', async () => {
    const counter = counterFile();
    const { lines, url } = await start({
      idleMinutes: 0.005,
      stubEnv: {
        STUB_CAPABILITIES: JSON.stringify({ tools: { listChanged: true } }),
        STUB_COUNTER: counter,
        STUB_MODE: ',raw',
        STUB_VERSION: '2025-06-18',
      },
    });
    const older = await openRawSession(url, { protocolVersion: '2025-06-18' });
    const newer = await openRawSession(url, { protocolVersion: '2025-11-25' });
    await waitFor(() => stoppedLine(lines, 'idle'));

    const { messages } = await requestOn(url, older.headers, { id: 1, method: 'tools/list' });

    expect(messages).toEqual([{ id: 1, jsonrpc: '2.0', result: { tools: [] } }]);
    expect(lines.filter((line) => line.endsWith('ended: child changed.'))).toHaveLength(1);
    expect((await requestOn(url, newer.headers, { id: 2, method: 'tools/list' })).status).toBe(404);
  });
});

describe('shutdown', () => {
  test('a waiting initialize gets 503, a waiting request gets an error, and every Child stops', async () => {
    const marker = `marker-${crypto.randomUUID()}`;
    const { lines, listener, store, url } = await start({
      idleMinutes: 0.005,
      marker,
      stubEnv: { STUB_COUNTER: counterFile(), STUB_MODE: ',mute' },
    });
    const { accessToken } = connectOAuthClient(store);
    const { headers } = await openRawSession(url);
    await waitFor(() => stoppedLine(lines, 'idle'));
    const waiting = requestOn(url, headers, toolCall(1, 'echo', { text: 'never' }));
    const opening = post(url, { Authorization: `Bearer ${accessToken}` });
    await waitFor(() => childStarts(lines).length === 3);

    await listener.close();

    expect((await opening).status).toBe(503);
    expect((await waiting).messages).toEqual([{ error: sessionEnded, id: 1, jsonrpc: '2.0' }]);
    expect(await processesWith(marker)).toEqual([]);
  });
});

describe('the protocol header', () => {
  test('a request naming a protocol version Modgud does not support gets 400', async () => {
    const { url } = await start();
    const { headers } = await openRawSession(url);
    const listWith = async (version: string) =>
      (
        await requestOn(
          url,
          { ...headers, 'Mcp-Protocol-Version': version },
          { id: 1, method: 'tools/list' },
        )
      ).status;

    expect(await listWith('2026-07-28')).toBe(400);
    expect(await listWith('2024-11-05')).toBe(400);
    expect(await listWith('2025-06-18')).toBe(200);
  });
});
