import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { sha256Hex } from './bearer.ts';

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

test('serve answers MCP on the configured Service path and ends its Sessions on SIGTERM', async () => {
  const configPath = join(directory, 'modgud.toml');
  await writeFile(
    configPath,
    `
      [harness]
      bearer_token_sha256 = "${sha256Hex('serve-token')}"
      service = "stub"

      [public]
      port = 0
      base_url = "https://modgud.example.com"

      [admin]
      base_url = "https://modgud.example.ts.net"
      host = "100.64.0.1"

      [services.stub]
      command = ${JSON.stringify(process.execPath)}
      args = [${JSON.stringify(`${import.meta.dir}/testing/stub-service.ts`)}]
    `,
  );
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/main.ts`, 'serve', '--config', configPath],
    { env: plainEnvironment, stderr: 'pipe', stdout: 'pipe' },
  );
  const lines = linesOf(child.stdout)[Symbol.asyncIterator]();
  const listening = await readUntil(lines, / info Listening on /u);
  const base = /Listening on (\S+) for \/stub\/mcp\.$/u.exec(listening)?.[1] ?? '';

  const client = new Client({ name: 'serve-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('stub/mcp', base), {
      requestInit: { headers: { Authorization: 'Bearer serve-token' } },
    }),
  );
  const result = await client.callTool({ arguments: { text: 'served' }, name: 'echo' });
  expect(result.content).toEqual([{ text: 'served', type: 'text' }]);
  await readUntil(lines, / info stub session \w{8} opened\.$/u);

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
