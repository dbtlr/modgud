// Measures what Modgud adds to each tool call. It calls one tool on a stdio
// Service directly, then the same tool through an in-process Public listener
// on localhost, and prints the latency of each and the difference.
//
//   bun packages/modgud/scripts/bench-overhead.ts --calls 200 --tool vault.count \
//     -- norn mcp -C /path/to/fixture-vault
//
// Everything after `--` is the Service's command and arguments. The Service
// runs with the same environment both ways.
import { parseArgs } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { sha256Hex } from '../src/bearer.ts';
import { childEnvironment } from '../src/child-environment.ts';
import { parseConfig } from '../src/config.ts';
import { createPublicListener } from '../src/public-listener.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    arguments: { default: '{}', type: 'string' },
    calls: { default: '200', type: 'string' },
    tool: { type: 'string' },
    warmup: { default: '20', type: 'string' },
  },
});
const [command, ...args] = positionals;
if (command === undefined || values.tool === undefined) {
  throw new Error('Usage: bench-overhead.ts --tool <name> [--calls N] -- <command> [args...]');
}
const tool = values.tool;
const parsedArguments: unknown = JSON.parse(values.arguments);
if (
  typeof parsedArguments !== 'object' ||
  parsedArguments === null ||
  Array.isArray(parsedArguments)
) {
  throw new Error('--arguments must be a JSON object.');
}
const toolArguments = Object.fromEntries(Object.entries(parsedArguments));
const calls = Number(values.calls);
const warmup = Number(values.warmup);

type Timing = { connectMs: number; callMs: number[] };

const time = async (client: Client, connect: () => Promise<void>): Promise<Timing> => {
  const connectStart = performance.now();
  await connect();
  const connectMs = performance.now() - connectStart;
  const callMs: number[] = [];
  for (let index = 0; index < warmup + calls; index += 1) {
    const start = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- calls are timed one at a time
    await client.callTool({ arguments: toolArguments, name: tool });
    if (index >= warmup) {
      callMs.push(performance.now() - start);
    }
  }
  await client.close();
  return { callMs, connectMs };
};

const percentile = (sorted: number[], fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN;

const summary = (timing: Timing) => {
  const sorted = timing.callMs.toSorted((a, b) => a - b);
  return {
    connect: timing.connectMs,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
};

const environment = childEnvironment({
  identity: undefined,
  parent: process.env,
  service: { env: {} },
});

const direct = await (async () => {
  const client = new Client({ name: 'bench-direct', version: '1.0.0' });
  return time(client, async () =>
    client.connect(new StdioClientTransport({ args, command, env: environment })),
  );
})();

const proxied = await (async () => {
  const token = crypto.randomUUID();
  const config = parseConfig(`
    [harness]
    bearer_token_sha256 = "${sha256Hex(token)}"

    [services.bench]
    command = ${JSON.stringify(command)}
    args = ${JSON.stringify(args)}
  `);
  const listener = createPublicListener({
    config,
    log: { info: () => undefined, warn: (line) => console.error(line) },
    parentEnvironment: process.env,
  });
  const server = Bun.serve({
    fetch: listener.fetch,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    port: 0,
  });
  const client = new Client({ name: 'bench-proxied', version: '1.0.0' });
  try {
    return await time(client, async () =>
      client.connect(
        new StreamableHTTPClientTransport(new URL('/bench/mcp', server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      ),
    );
  } finally {
    await listener.close();
    await server.stop(true);
  }
})();

const d = summary(direct);
const p = summary(proxied);
const ms = (value: number) => `${value.toFixed(2)} ms`;
console.log(`${String(calls)} calls of ${tool}, after ${String(warmup)} warm-up calls`);
console.log(`              direct      proxied     added`);
for (const [label, key] of [
  ['connect', 'connect'],
  ['call p50', 'p50'],
  ['call p95', 'p95'],
] as const) {
  console.log(
    `${label.padEnd(12)}  ${ms(d[key]).padEnd(10)}  ${ms(p[key]).padEnd(10)}  ${ms(p[key] - d[key])}`,
  );
}
