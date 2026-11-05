// A stdio MCP server that integration tests start as a Service. Each tool
// exercises one thing the proxy must pass through unchanged, or one way a
// Service can misbehave. With `STUB_MODE=mute` it reads its input and never
// answers, not even `initialize`. With `STUB_MODE=ignore-sigterm` it serves
// as usual but ignores SIGTERM, so only SIGKILL stops it.
import { once } from 'node:events';
import { close } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

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

server.registerTool('roots', { description: 'Ask the Caller for its roots.' }, async (context) => {
  const result = await context.mcpReq.send({ method: 'roots/list' });
  return text(JSON.stringify(result.roots));
});

server.registerTool('exit', { description: 'Exit the process right after answering.' }, () => {
  setTimeout(() => process.exit(0), 20);
  return text('bye');
});

server.registerTool('slow', { description: 'Answer only after a minute.' }, async () => {
  await Bun.sleep(60_000);
  return text('late');
});

// Settles once the Caller cancels a `wait-for-cancel` call.
const cancelled = Promise.withResolvers<void>();

server.registerTool(
  'wait-for-cancel',
  { description: 'Answer nothing until the Caller cancels the call.' },
  async (context) => {
    process.stderr.write('waiting for cancel\n');
    await once(context.mcpReq.signal, 'abort');
    cancelled.resolve();
    return text('cancelled');
  },
);

server.registerTool(
  'notify-after-cancel',
  {
    description:
      'Once a wait-for-cancel call is cancelled, write a notification without a progress token, then answer.',
  },
  async () => {
    process.stderr.write('waiting to notify\n');
    await cancelled.promise;
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: 'after cancel', level: 'info' },
    };
    process.stdout.write(`${JSON.stringify(notification)}\n`);
    return text('notified');
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
    process.stdout.write(`${JSON.stringify({ id, jsonrpc: '2.0', result: {} })}\n`);
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

process.stderr.write('stub-service started\n');
if (process.env.STUB_MODE === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    process.stderr.write('ignored SIGTERM\n');
  });
}
if (process.env.STUB_MODE === 'mute') {
  process.stdin.resume();
} else {
  await server.connect(new StdioServerTransport());
}
