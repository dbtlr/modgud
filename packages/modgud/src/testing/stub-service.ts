// A stdio MCP server that integration tests start as a Service. Each tool
// exercises one thing the proxy must pass through unchanged.
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

process.stderr.write('stub-service started\n');
await server.connect(new StdioServerTransport());
