// A stdio MCP server that integration tests start as a Service. Each tool
// exercises one thing the proxy must route, answer, or pass through, or one
// way a Service can misbehave.
//
// `STUB_MODE` picks how it runs:
// - empty: an ordinary MCP server with the tools below.
// - `mute`: reads its input and never answers, not even `initialize`.
// - `ignore-sigterm`: serves as usual but ignores SIGTERM, so only SIGKILL
//   stops it.
// - `exit`: exits with status 1 before reading anything.
// - `raw`: answers `initialize` with the protocol version in `STUB_VERSION`
//   (2025-11-25 by default) and the capabilities in `STUB_CAPABILITIES`
//   (JSON, `{"tools":{}}` by default), `ping` and `tools/list` as an empty
//   server would, and every other request with an error.
//
// `STUB_MODE` may list several modes, separated by commas, with
// `STUB_COUNTER` naming a file that counts starts: the nth start runs the nth
// mode, and every later start runs the last one.
//
// With `STUB_TRACE=1` it writes each message it receives to stderr as
// `received <json>`.
import { once } from 'node:events';
import { close } from 'node:fs';

import { isJSONRPCResponse, McpServer } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, JSONRPCResponse } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// This start's mode, read from `STUB_MODE` and the start counter.
const currentMode = async () => {
  const modes = (process.env.STUB_MODE ?? '').split(',');
  const counter = process.env.STUB_COUNTER;
  if (counter === undefined || counter === '') {
    return modes[0] ?? '';
  }
  const file = Bun.file(counter);
  const starts = (await file.exists()) ? Number(await file.text()) : 0;
  await Bun.write(counter, String(starts + 1));
  return modes[Math.min(starts, modes.length - 1)] ?? '';
};

const mode = await currentMode();
const trace = process.env.STUB_TRACE === '1';

const write = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const traced = (message: unknown) => {
  if (trace) {
    process.stderr.write(`received ${JSON.stringify(message)}\n`);
  }
};

// Reads newline-delimited JSON-RPC messages from stdin and calls `handle` with
// each one, for the modes that run no MCP server.
const readLines = async (handle: (message: Record<string, unknown>) => void) => {
  let pending = '';
  for await (const chunk of process.stdin) {
    const lines = `${pending}${String(chunk)}`.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines.filter((text) => text.trim() !== '')) {
      const message: unknown = JSON.parse(line);
      traced(message);
      if (typeof message === 'object' && message !== null) {
        handle(Object.fromEntries(Object.entries(message)));
      }
    }
  }
};

const answerRaw = (message: Record<string, unknown>) => {
  const { id, method } = message;
  if (id === undefined || typeof method !== 'string') {
    return;
  }
  if (method === 'initialize') {
    const capabilities: unknown = JSON.parse(process.env.STUB_CAPABILITIES ?? '{"tools":{}}');
    write({
      id,
      jsonrpc: '2.0',
      result: {
        capabilities,
        protocolVersion: process.env.STUB_VERSION ?? '2025-11-25',
        serverInfo: { name: 'raw-stub', version: '1.0.0' },
      },
    });
  } else if (method === 'ping') {
    write({ id, jsonrpc: '2.0', result: {} });
  } else if (method === 'tools/list') {
    write({ id, jsonrpc: '2.0', result: { tools: [] } });
  } else {
    write({ error: { code: -32_601, message: 'Method not found' }, id, jsonrpc: '2.0' });
  }
};

const server = new McpServer({ name: 'stub-service', version: '1.0.0' });
const text = (value: string) => ({ content: [{ text: value, type: 'text' as const }] });

server.registerTool(
  'echo',
  {
    annotations: { readOnlyHint: true },
    description: 'Return the text it is given.',
    inputSchema: z.object({ text: z.string() }),
  },
  ({ text: value }) => text(value),
);

server.registerTool('environment', { description: 'Return the environment as JSON.' }, () =>
  text(JSON.stringify(process.env)),
);

server.registerTool('pid', { description: 'Return the process id.' }, () =>
  text(String(process.pid)),
);

server.registerTool(
  'progress',
  { description: 'Report progress once, then finish.' },
  async (context) => {
    const progressToken = context.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) {
      await context.mcpReq.notify({
        method: 'notifications/progress',
        params: { progress: 1, progressToken, total: 1 },
      });
    }
    return text('done');
  },
);

server.registerTool(
  'progress-ticks',
  { description: 'Report progress every 100 ms, 8 times, then finish.' },
  async (context) => {
    const progressToken = context.mcpReq._meta?.progressToken;
    for (let tick = 1; tick <= 8; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(100);
      if (progressToken !== undefined) {
        // oxlint-disable-next-line no-await-in-loop
        await context.mcpReq.notify({
          method: 'notifications/progress',
          params: { progress: tick, progressToken, total: 8 },
        });
      }
    }
    return text('done');
  },
);

server.registerTool(
  'progress-echo',
  {
    description: 'Report progress with the text it is given, wait 100 ms, then return the text.',
    inputSchema: z.object({ text: z.string() }),
  },
  async ({ text: value }, context) => {
    const progressToken = context.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) {
      await context.mcpReq.notify({
        method: 'notifications/progress',
        params: { message: value, progress: 1, progressToken, total: 1 },
      });
    }
    await Bun.sleep(100);
    return text(value);
  },
);

// Requests this process sent to its client, by id, until the client answers.
const outgoing = new Map<string, (response: JSONRPCResponse) => void>();
let outgoingCount = 0;

server.registerTool(
  'child-request',
  {
    description: 'Send the client a request with the given method and return its answer as JSON.',
    inputSchema: z.object({ method: z.string() }),
  },
  async ({ method }) => {
    outgoingCount += 1;
    const id = `stub-request-${String(outgoingCount)}`;
    const answered = Promise.withResolvers<JSONRPCResponse>();
    outgoing.set(id, answered.resolve);
    write({ id, jsonrpc: '2.0', method, params: {} });
    const response = await answered.promise;
    return text(JSON.stringify(response));
  },
);

server.registerTool('list-changed', { description: 'Announce that the tool list changed.' }, () => {
  server.sendToolListChanged();
  return text('announced');
});

server.registerTool(
  'log',
  {
    description: 'Write a logging notification with the given text, then answer.',
    inputSchema: z.object({ text: z.string() }),
  },
  ({ text: value }) => {
    write({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: value, level: 'info' },
    });
    return text('logged');
  },
);

server.registerTool(
  'stderr',
  {
    description: 'Write the given text to stderr as one line, then answer.',
    inputSchema: z.object({ text: z.string() }),
  },
  ({ text: value }) => {
    process.stderr.write(`${value}\n`);
    return text('written');
  },
);

server.registerTool('exit', { description: 'Exit the process right after answering.' }, () => {
  setTimeout(() => process.exit(0), 20);
  return text('bye');
});

server.registerTool('crash', { description: 'Exit the process without answering.' }, () =>
  process.exit(1),
);

server.registerTool(
  'slow',
  {
    description: 'Answer after the given milliseconds, a minute by default, ignoring cancellation.',
    inputSchema: z.object({ ms: z.number().optional() }),
  },
  async ({ ms }) => {
    await Bun.sleep(ms ?? 60_000);
    return text('late');
  },
);

server.registerTool(
  'answer-despite-cancel',
  {
    description:
      'After the given milliseconds, write a response for this call even if it was cancelled.',
    inputSchema: z.object({ ms: z.number() }),
  },
  async ({ ms }, context) => {
    await Bun.sleep(ms);
    // The SDK sends no response to a cancelled request, so write one directly.
    write({ id: context.mcpReq.id, jsonrpc: '2.0', result: text('late') });
    return text('late');
  },
);

// Settles once the Caller cancels a `wait-for-cancel` call.
const cancelled = Promise.withResolvers<void>();

server.registerTool(
  'wait-for-cancel',
  { description: 'Answer nothing until the Caller cancels the call.' },
  async (context) => {
    const id = JSON.stringify(context.mcpReq.id);
    process.stderr.write(`waiting for cancel ${id}\n`);
    await once(context.mcpReq.signal, 'abort');
    process.stderr.write(`cancelled ${id}\n`);
    cancelled.resolve();
    return text('cancelled');
  },
);

// More than the 10 MiB a Child's single message may take.
server.registerTool('oversized', { description: 'Return an 11 MiB result.' }, () =>
  text('x'.repeat(11 * 1024 * 1024)),
);

server.registerTool(
  'unmatched-response',
  { description: 'Write a response to a request no Caller sent, then answer.' },
  () => {
    // An id with a newline, which must not start a second log line.
    const id = 'forged\n2026-01-01T00:00:00.000Z warn forged line';
    write({ id, jsonrpc: '2.0', result: {} });
    return text('sent');
  },
);

server.registerTool(
  'close-stdin',
  { description: 'Answer, then close stdin and keep running, so writes to it fail.' },
  () => {
    setTimeout(() => {
      close(0, () => undefined);
      // Keep the process alive with its stdin closed.
      setInterval(() => undefined, 1000);
    }, 20);
    return text('closing');
  },
);

// Serves the MCP server, taking the client's answers to `child-request`
// before the server sees them.
const serve = async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const deliver = transport.onmessage;
  // The SDK's Transport interface takes its handlers as properties.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message: JSONRPCMessage) => {
    traced(message);
    if (isJSONRPCResponse(message) && typeof message.id === 'string') {
      const answer = outgoing.get(message.id);
      if (answer !== undefined) {
        outgoing.delete(message.id);
        answer(message);
        return;
      }
    }
    deliver?.(message);
  };
};

process.stderr.write('stub-service started\n');
if (mode === 'exit') {
  process.exit(1);
}
if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    process.stderr.write('ignored SIGTERM\n');
  });
}
if (mode === 'mute') {
  await readLines(() => undefined);
} else if (mode === 'raw') {
  await readLines(answerRaw);
} else {
  await serve();
}
