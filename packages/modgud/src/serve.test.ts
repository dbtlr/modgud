import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { sha256Hex } from './bearer.ts';
import { s256Challenge } from './pkce.ts';
import { listen } from './serve.ts';
import { openStore } from './store.ts';

const directory = await mkdtemp(join(tmpdir(), 'modgud-serve-'));
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const plainEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== 'FORCE_COLOR'),
);

// Reads the child's stdout until a line matches, returning that line.
const readUntil = async (lines: AsyncIterator<string>, pattern: RegExp) => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- lines arrive one at a time
    const next = await lines.next();
    if (next.done === true) {
      throw new Error(`stdout ended before a line matched ${String(pattern)}.`);
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
const writeServeConfig = async (name: string) => {
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

// Starts `modgud serve`, with its Admin listener on 127.0.0.1 in place of the
// configured tailnet address, and returns both listeners' URLs once they listen.
const startServe = async (configPath: string) => {
  const child = Bun.spawn(
    [
      process.execPath,
      `${import.meta.dir}/testing/serve-with-loopback-admin.ts`,
      'serve',
      '--config',
      configPath,
    ],
    { env: plainEnvironment, stderr: 'pipe', stdout: 'pipe' },
  );
  const lines = linesOf(child.stdout)[Symbol.asyncIterator]();
  const listening = await readUntil(lines, / info Listening on \S+ for \/stub\/mcp\.$/u);
  const base = /Listening on (\S+) for \/stub\/mcp\.$/u.exec(listening)?.[1] ?? '';
  const adminListening = await readUntil(lines, / info Listening on \S+ for the Approval page /u);
  const admin =
    /Listening on (\S+) for the Approval page at https:\/\/modgud\.example\.ts\.net\/authorize\.$/u.exec(
      adminListening,
    )?.[1] ?? '';
  return { admin, base, child, lines };
};

test('serve answers MCP on the configured Service path and ends its Sessions on SIGTERM', async () => {
  const { configPath } = await writeServeConfig('modgud');
  const { base, child, lines } = await startServe(configPath);

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
    / info stub session \w{8} opened for the static bearer token, Origin none, protocol \S+\.$/u,
  );

  child.kill('SIGTERM');
  await readUntil(lines, / info stub session \w{8} ended: shutdown\.$/u);
  await readUntil(lines, / info Stopped\.$/u);
  // Loom exits 143 after SIGTERM, once the action has finished its cleanup.
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
  await readUntil(lines, / info Stopped\.$/u);
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
  await readUntil(lines, / info Stopped\.$/u);
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
