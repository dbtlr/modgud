import type { RequestId } from '@modelcontextprotocol/server';

import { isRecord } from '../protocol.ts';

export type StubHttpRequest = {
  method: string;
  path: string;
  headers: [string, string][];
  message: unknown;
  signal: AbortSignal;
};

type StubHttpOptions = {
  sessionId?: string;
  protocolVersion?: string;
  respond?: (
    request: StubHttpRequest,
    server: Bun.Server<undefined>,
  ) => Response | Promise<Response> | undefined;
};

export const rpcResult = (id: RequestId, result: Record<string, unknown> = {}) =>
  ({ id, jsonrpc: '2.0', result }) as const;

export const httpEvent = (message: unknown) => `data: ${JSON.stringify(message)}\n\n`;

// An unfinished body lets tests observe cancellation without timing an answer.
export const httpStream = (
  chunks: readonly (string | Uint8Array)[],
  options: {
    cancelled?: () => void;
    hang?: boolean;
    status?: number;
  } = {},
) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        options.cancelled?.();
      },
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        }
        if (!options.hang) {
          controller.close();
        }
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: options.status ?? 200 },
  );
};

export const httpMethod = (request: StubHttpRequest) => {
  const method = isRecord(request.message) ? request.message.method : undefined;
  return typeof method === 'string' ? method : undefined;
};

export const httpId = (request: StubHttpRequest): RequestId => {
  const id = isRecord(request.message) ? request.message.id : undefined;
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('Expected a request id');
  }
  return id;
};

const echoTool = {
  description: 'Echo the supplied text.',
  inputSchema: { properties: { text: { type: 'string' } }, required: ['text'], type: 'object' },
  name: 'echo',
};

const defaultAnswer = (request: StubHttpRequest, options: StubHttpOptions): Response => {
  if (request.method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405 });
  }
  const method = httpMethod(request);
  if (method === undefined || method.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }
  const id = httpId(request);
  switch (method) {
    case 'initialize': {
      const headers = new Headers();
      if (options.sessionId !== undefined) {
        headers.set('Mcp-Session-Id', options.sessionId);
      }
      return Response.json(
        rpcResult(id, {
          capabilities: { tools: {} },
          protocolVersion: options.protocolVersion ?? '2025-11-25',
          serverInfo: { name: 'stub-http-service', version: '1' },
        }),
        { headers },
      );
    }
    case 'tools/list': {
      return Response.json(rpcResult(id, { tools: [echoTool] }));
    }
    case 'tools/call': {
      const params = isRecord(request.message) ? request.message.params : undefined;
      if (
        isRecord(params) &&
        params.name === 'echo' &&
        isRecord(params.arguments) &&
        typeof params.arguments.text === 'string'
      ) {
        return Response.json(
          rpcResult(id, { content: [{ text: params.arguments.text, type: 'text' }] }),
        );
      }
      return Response.json({
        error: { code: -32602, message: 'Expected echo and text' },
        id,
        jsonrpc: '2.0',
      });
    }
    default: {
      return Response.json(rpcResult(id));
    }
  }
};

export const startStubHttpService = (options: StubHttpOptions = {}) => {
  const requests: StubHttpRequest[] = [];
  const server = Bun.serve({
    async fetch(request, service) {
      const entry: StubHttpRequest = {
        headers: [...request.headers],
        message: undefined,
        method: request.method,
        path: new URL(request.url).pathname,
        signal: request.signal,
      };
      requests.push(entry);
      if (request.method === 'POST') {
        entry.message = await request.json();
      }
      return options.respond?.(entry, service) ?? defaultAnswer(entry, options);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return { requests, server, url: new URL('/mcp', server.url).href };
};

// Erroring a streaming response closes its socket while Bun is writing it.
export const resetHttpResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        setTimeout(() => controller.error(), 5);
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
