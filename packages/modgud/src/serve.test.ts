import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { sha256Hex } from './bearer.ts';
import { s256Challenge } from './pkce.ts';
import { listen } from './serve.ts';
import { openStore } from './store.ts';
import { appEnvironment, logPath } from './testing/app-environment.ts';
import { waitFor } from './testing/listener-harness.ts';

const directory = await mkdtemp(join(tmpdir(), 'modgud-serve-'));
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const plainEnvironment = appEnvironment(directory);

// Reads lines until one matches, returning that line.
const readUntil = async (lines: AsyncIterator<string>, pattern: RegExp) => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- lines arrive one at a time
    const next = await lines.next();
    if (next.done === true) {
      throw new Error(`The lines ended before one matched ${String(pattern)}.`);
    }
    if (pattern.test(next.value)) {
      return next.value;
    }
  }
};

async function* linesOf(stream: ReadableStream<Uint8Array>) {
  let pending = '';
  for await (const text of stream.pipeThrough(new TextDecoderStream())) {
    const lines = `${pending}${text}`.split('\n');
    pending = lines.pop() ?? '';
    yield* lines;
  }
}

// A configuration serving the stub Service, with its store in the test's directory.
const writeServeConfig = async (name: string, publicSettings = '') => {
  const configPath = join(directory, `${name}.toml`);
  const storePath = join(directory, `${name}.sqlite`);
  await writeFile(
    configPath,
    `
      [store]
      path = ${JSON.stringify(storePath)}

      [harness]
      bearer_token_sha256 = "${sha256Hex('serve-token')}"
      service = "stub"

      [public]
      port = 0
      base_url = "https://modgud.example.com"
      ${publicSettings}

      [admin]
      base_url = "https://modgud.example.ts.net"
      host = "100.64.0.1"
      port = 0

      [services.stub]
      command = ${JSON.stringify(process.execPath)}
      args = [${JSON.stringify(`${import.meta.dir}/testing/stub-service.ts`)}]
    `,
  );
  return { configPath, storePath };
};

// The records Loom's logging plugin writes to `path`, as `<level> <message>`,
// read as they arrive until `exited` says the process that writes them ended.
async function* logRecordsOf(path: string, exited: () => boolean) {
  let seen = 0;
  for (;;) {
    const wasFinished = exited();
    // oxlint-disable-next-line no-await-in-loop -- the file grows while serve runs
    const text = await readFile(path, 'utf8').catch(() => '');
    const complete = text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .slice(0, -1);
    for (const line of complete.slice(seen)) {
      const record = JSON.parse(line) as { level: string; message: string };
      yield `${record.level} ${record.message}`;
    }
    seen = complete.length;
    if (wasFinished) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polls the file
    await Bun.sleep(20);
  }
}

// Starts `modgud serve`, with its Admin listener on 127.0.0.1 in place of the
// configured tailnet address and its state directory in the test's directory.
// It returns both listeners' URLs, which serve prints once they listen, and
// the records serve logs.
const startServe = async (configPath: string) => {
  const scratch = await mkdtemp(join(directory, 'serve-'));
  const child = Bun.spawn(
    [
      process.execPath,
      `${import.meta.dir}/testing/serve-with-loopback-admin.ts`,
      'serve',
      '--config',
      configPath,
    ],
    {
      env: appEnvironment(scratch),
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const printed = linesOf(child.stdout)[Symbol.asyncIterator]();
  const listening = await readUntil(printed, /^Listening on \S+ for \/stub\/mcp\.$/u);
  const base = /Listening on (\S+) for \/stub\/mcp\.$/u.exec(listening)?.[1] ?? '';
  const adminListening = await readUntil(printed, /^Listening on \S+ for the Approval page /u);
  const admin =
    /Listening on (\S+) for the Approval page at https:\/\/modgud\.example\.ts\.net\/authorize\.$/u.exec(
      adminListening,
    )?.[1] ?? '';
  const lines = logRecordsOf(logPath(scratch), () => child.exitCode !== null)[
    Symbol.asyncIterator
  ]();
  return { admin, base, child, lines, printed };
};

test('serve answers MCP on the configured Service path and ends its Sessions on SIGTERM', async () => {
  const { configPath } = await writeServeConfig('modgud');
  const { base, child, lines, printed } = await startServe(configPath);

  const client = new Client({ name: 'serve-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('stub/mcp', base), {
      requestInit: { headers: { Authorization: 'Bearer serve-token' } },
    }),
  );
  const result = await client.callTool({ arguments: { text: 'served' }, name: 'echo' });
  expect(result.content).toEqual([{ text: 'served', type: 'text' }]);
  await readUntil(
    lines,
    /^info stub session \w{8} opened for the static bearer token, Origin none, protocol \S+\.$/u,
  );

  child.kill('SIGTERM');
  await readUntil(lines, /^info stub session \w{8} ended: shutdown\.$/u);
  await readUntil(lines, /^info Stopped\.$/u);
  await readUntil(printed, /^Stopped\.$/u);
  // Loom exits 143 after SIGTERM, once the action has finished its cleanup.
  expect(await child.exited).toBe(143);
});

test('serve starts with the retired public.max_sessions set, and warns that it is ignored', async () => {
  const { configPath } = await writeServeConfig('retired', 'max_sessions = 16');
  const { child, lines } = await startServe(configPath);
  try {
    await readUntil(lines, /^warn In \S+: public\.max_sessions is ignored: /u);
    child.kill('SIGTERM');
    await readUntil(lines, /^info Stopped\.$/u);
    expect(await new Response(child.stderr).text()).toContain(
      `In ${configPath}: public.max_sessions is ignored: Modgud now limits the Sessions of each Grant with public.max_sessions_per_grant, which is 64.`,
    );
  } finally {
    child.kill('SIGTERM');
  }
  expect(await child.exited).toBe(143);
});

test('serve refuses an invalid configuration, naming the file and the setting', async () => {
  const configPath = join(directory, 'invalid.toml');
  await writeFile(configPath, '[harness]\nbearer_token_sha256 = "plain"\n');
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/main.ts`, 'serve', '--config', configPath],
    { env: plainEnvironment, stderr: 'pipe', stdout: 'pipe' },
  );

  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain(configPath);
  expect(stderr).toContain('harness.bearer_token_sha256');
});

test('serve opens the configured store and serves the OAuth endpoints and access tokens', async () => {
  const { configPath, storePath } = await writeServeConfig('oauth');
  const { base, child, lines } = await startServe(configPath);
  try {
    const metadata = await fetch(new URL('.well-known/oauth-authorization-server', base));
    const registration = await fetch(new URL('oauth/register', base), {
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe(
      'https://modgud.example.com',
    );
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    // Approves the client from a second handle on the store, as the Admin
    // listener will, and redeems the code at the server's token endpoint.
    const store = await openStore({
      maxTokenLifetimeDays: 30,
      path: storePath,
      resource: 'https://modgud.example.com/stub/mcp',
      warn: () => undefined,
    });
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const approved = store.approve({
      clientId,
      codeChallenge: s256Challenge(verifier),
      pairingCode: store.mintPairingCode(10).code,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      requestedRedirectUri: null,
    });
    store.close();
    const tokenResponse = await fetch(new URL('oauth/token', base), {
      body: new URLSearchParams({
        client_id: clientId,
        code: approved?.code ?? '',
        code_verifier: verifier,
        grant_type: 'authorization_code',
      }),
      method: 'POST',
    });
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

    const client = new Client({ name: 'serve-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('stub/mcp', base), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    const result = await client.callTool({ arguments: { text: 'oauth' }, name: 'echo' });
    expect(result.content).toEqual([{ text: 'oauth', type: 'text' }]);
  } finally {
    child.kill('SIGTERM');
  }
  await readUntil(lines, /^info Stopped\.$/u);
  expect(await child.exited).toBe(143);
});

test('serve answers the Approval page on the Admin listener, only for its configured host', async () => {
  const { configPath } = await writeServeConfig('admin');
  const { admin, child, lines } = await startServe(configPath);
  try {
    const misdirected = await fetch(new URL('authorize', admin));
    const page = await fetch(new URL('authorize?client_id=unknown', admin), {
      headers: { Host: 'modgud.example.ts.net' },
    });
    const elsewhere = await fetch(new URL('oauth/token', admin), {
      headers: { Host: 'modgud.example.ts.net' },
    });

    expect(admin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect(misdirected.status).toBe(421);
    expect(page.status).toBe(400);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Remove the connector from the client and add it again');
    expect(elsewhere.status).toBe(404);
  } finally {
    child.kill('SIGTERM');
  }
  await readUntil(lines, /^info Stopped\.$/u);
  expect(await child.exited).toBe(143);
});

test('serve logs the Approval page’s decisions and the errors either listener answers with HTTP 500', async () => {
  const { configPath } = await writeServeConfig('logged');
  const { admin, base, child, lines } = await startServe(configPath);
  try {
    const registration = await fetch(new URL('oauth/register', base), {
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const query = new URLSearchParams({
      client_id: clientId,
      code_challenge: s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      code_challenge_method: 'S256',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      state: 'state-123',
    });
    const page = await fetch(new URL(`authorize?${query.toString()}`, admin), {
      headers: {
        Host: 'modgud.example.ts.net',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    const request = /name="request" value="([^"]+)"/u.exec(await page.text())?.[1] ?? '';
    const denied = await fetch(new URL('authorize', admin), {
      body: new URLSearchParams({ action: 'deny', request }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: page.headers.get('set-cookie')?.split(';')[0] ?? '',
        Host: 'modgud.example.ts.net',
        Origin: 'https://modgud.example.ts.net',
      },
      method: 'POST',
      redirect: 'manual',
    });
    expect(denied.status).toBe(303);
    await readUntil(lines, /^info Denied client /u);

    const publicThrown = await fetch(new URL('modgud-test-throw', base));
    const adminThrown = await fetch(new URL('modgud-test-throw', admin), {
      headers: { Host: 'modgud.example.ts.net' },
    });
    expect([publicThrown.status, adminThrown.status]).toEqual([500, 500]);
    await readUntil(lines, /^warn Answered a request with HTTP 500: thrown past the listener$/u);
    await readUntil(lines, /^warn Answered a request with HTTP 500: thrown past the listener$/u);
  } finally {
    child.kill('SIGTERM');
  }
  expect(await child.exited).toBe(143);
});

test('serve refuses to start when the Admin listener cannot listen, naming its address', async () => {
  // 100.127.255.254 is a tailnet-range address this host does not have.
  const { configPath } = await writeServeConfig('unbound');
  const text = await Bun.file(configPath).text();
  await writeFile(configPath, text.replace('host = "100.64.0.1"', 'host = "100.127.255.254"'));
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/main.ts`, 'serve', '--config', configPath],
    { env: plainEnvironment, stderr: 'pipe', stdout: 'pipe' },
  );

  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('Could not listen on 100.127.255.254:0');
});

test('a listener answers an error that escapes its handler with a plain HTTP 500, not Bun’s error page', async () => {
  const lines: string[] = [];
  const log = {
    info: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
  };
  const server = listen(
    {
      fetch: () => Promise.reject(new Error('store exploded at /secret/path')),
      host: '127.0.0.1',
      idleTimeout: 5,
      log,
      port: 0,
    },
    (message) => {
      throw new Error(message);
    },
  );
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Internal Server Error');
    expect(lines).toEqual(['Answered a request with HTTP 500: store exploded at /secret/path']);
  } finally {
    await server.stop(true);
  }
});

// A listener failure as a thrown error, so a test can expect it.
const fail = (message: string): never => {
  throw new Error(message);
};

test('a listener refuses a host and port another listener already holds', async () => {
  const log = { info: () => undefined, warn: () => undefined };
  const options = {
    fetch: () => Promise.resolve(new Response('ok')),
    host: '127.0.0.1',
    idleTimeout: 5,
    log,
  };
  const first = listen({ ...options, port: 0 }, fail);
  try {
    expect(() => listen({ ...options, port: first.port ?? 0 }, fail)).toThrow(
      `Could not listen on 127.0.0.1:${String(first.port)}`,
    );
  } finally {
    await first.stop(true);
  }
});

// An idle timeout short enough for a test. Bun's idle timer works in steps of
// about 4 seconds, so a short timeout can end a connection that is still
// taking output: at 4 seconds or less, or when writes come nearly a whole
// timeout apart. The reading Caller here gets a write every second.
const TEST_IDLE_SECONDS = 8;

// A response body that keeps producing until the server cancels it. `burst`
// bytes go out at once, so a Caller that stops reading backs the connection
// up past every socket buffer; then a keepalive goes out every second, as the
// MCP transport writes one while a stream is open.
const endlessBody = (burst: number, onCancel: () => void) => {
  const chunk = new Uint8Array(1024 * 1024);
  const keepalive = new TextEncoder().encode(': keepalive\n\n');
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      cancel: onCancel,
      pull: async (controller) => {
        if (sent < burst) {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
          return;
        }
        await Bun.sleep(1000);
        controller.enqueue(keepalive);
      },
    },
    { highWaterMark: 0 },
  );
};

// A raw HTTP connection that sends one GET for `path`. A stalled Caller stops
// reading at the first bytes it receives.
const rawGet = (port: number, path: string, { stall }: { stall: boolean }) => {
  const socket: Socket = connect(port, '127.0.0.1', () => {
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  });
  const state = { bytes: 0, ended: false };
  socket.on('data', (data: Buffer) => {
    state.bytes += data.byteLength;
  });
  if (stall) {
    socket.once('data', () => socket.pause());
  }
  socket.on('end', () => {
    state.ended = true;
  });
  return { socket, state };
};

test(
  'a listener ends a connection whose Caller stops reading, while keepalives still arrive, and keeps one that reads',
  async () => {
    const log = { info: () => undefined, warn: () => undefined };
    const cancelled = { reading: 0, stalled: 0 };
    const started = performance.now();
    const server = listen(
      {
        fetch: (request) =>
          Promise.resolve(
            new URL(request.url).pathname === '/stalled'
              ? new Response(
                  endlessBody(64 * 1024 * 1024, () => {
                    cancelled.stalled = performance.now();
                  }),
                )
              : new Response(
                  endlessBody(0, () => {
                    cancelled.reading = performance.now();
                  }),
                ),
          ),
        host: '127.0.0.1',
        idleTimeout: TEST_IDLE_SECONDS,
        log,
        port: 0,
      },
      fail,
    );
    const port = server.port ?? 0;
    const stalled = rawGet(port, '/stalled', { stall: true });
    const reading = rawGet(port, '/reading', { stall: false });
    try {
      // The server ends the stalled response no sooner than its idle timeout,
      // though a keepalive reached its body every second.
      await waitFor(() => cancelled.stalled > 0, (TEST_IDLE_SECONDS * 2 + 4) * 1000);
      expect(cancelled.stalled - started).toBeGreaterThanOrEqual((TEST_IDLE_SECONDS - 1) * 1000);
      // It closed the connection too: the Caller, reading again, gets what the
      // sockets hold and then the end of the connection, well short of the burst.
      stalled.socket.resume();
      await waitFor(() => stalled.state.ended, 10_000);
      expect(stalled.state.bytes).toBeLessThan(64 * 1024 * 1024);

      // The reading Caller has outlived the idle timeout and keeps its stream.
      await Bun.sleep(Math.max(0, (TEST_IDLE_SECONDS + 4) * 1000 - (performance.now() - started)));
      expect(reading.state.ended).toBe(false);
      expect(cancelled.reading).toBe(0);
      const before = reading.state.bytes;
      await waitFor(() => reading.state.bytes > before, 3000);
    } finally {
      stalled.socket.destroy();
      reading.socket.destroy();
      await server.stop(true);
    }
  },
  { timeout: (TEST_IDLE_SECONDS * 4 + 20) * 1000 },
);
