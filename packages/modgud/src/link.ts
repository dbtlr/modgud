// One Grant's run against an HTTP Service. GrantRelay owns the Sessions and
// decides which messages and requests belong to each of them.
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse,
  RequestId,
} from '@modelcontextprotocol/server';

import packageMetadata from '../package.json';
import { expandHome } from './config.ts';
import type { HttpServiceConfig } from './config.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import { CHILD_PROTOCOL_VERSION, parseChildInitializeResult } from './protocol.ts';
import { readServiceBearer } from './service-bearer.ts';
import { eventData } from './sse.ts';
import type { StartResult, StopReason, Upstream, UpstreamEvents } from './upstream.ts';

export const LINK_LIMITS = {
  answersInFlight: 64,
  auxiliaryTimeoutMs: 2000,
  cancellationsInFlight: 64,
  messageBytes: 10 * 1024 * 1024,
  startDeadlineMs: 30_000,
};

export type LinkOptions = {
  events: UpstreamEvents;
  home: string;
  log: Log;
  limits?: Partial<typeof LINK_LIMITS>;
  nextId: () => number;
  service: HttpServiceConfig;
  serviceName: string;
};

const MODGUD_INFO = { name: 'modgud', version: packageMetadata.version };

type Reply = JSONRPCErrorResponse | JSONRPCResultResponse;

type LinkFailure = 'refused' | 'unauthorized' | 'session ended';

class LinkFaultError extends Error {
  override name = 'LinkFaultError';
  readonly kind: LinkFailure;

  constructor(kind: LinkFailure, reason: string) {
    super(reason);
    this.kind = kind;
  }
}

const discardBody = async (response: Response) => {
  try {
    await response.body?.cancel();
  } catch {
    // A closed socket has already discarded the body.
  }
};

const parseMessage = (text: string): JSONRPCMessage => {
  const value: unknown = JSON.parse(text);
  return parseJSONRPCMessage(value);
};

const matchingReply = (message: JSONRPCMessage, id: RequestId): Reply => {
  if ('method' in message || message.id !== id) {
    throw new Error('Expected the response to this request');
  }
  return message;
};

const readJson = async (body: ReadableStream<Uint8Array>, maxBytes: number) => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new Error('JSON message exceeds the limit');
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return parseMessage(text + decoder.decode());
};

type State = 'new' | 'starting' | 'running' | 'stopped';
type Auxiliary = 'cancellation' | 'answer' | 'delete';
type LinkEnd =
  | { kind: 'local'; reason: StopReason }
  | { kind: 'failed'; reason: string; fault?: LinkFailure | undefined };

// The public interface never waits for a caller request's Service POST.
class Link implements Upstream {
  readonly restartsAtOnce = true;
  readonly workOutlivesStop = true;
  private readonly settled = Promise.withResolvers<void>();
  readonly stopped = this.settled.promise;
  private readonly interrupted = Promise.withResolvers<StartResult>();
  private readonly startController = new AbortController();
  private readonly requests = new Map<RequestId, AbortController>();
  private readonly auxiliary = new Map<AbortController, Auxiliary>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/json',
    'User-Agent': `modgud/${MODGUD_INFO.version}`,
  });
  private readonly limits: typeof LINK_LIMITS;
  private readonly options: LinkOptions;
  private state: State = 'new';

  constructor(options: LinkOptions) {
    this.options = options;
    this.limits = { ...LINK_LIMITS, ...options.limits };
  }

  async start(): Promise<StartResult> {
    if (this.state !== 'new') {
      return { kind: 'failed', reason: 'Link is no longer new' };
    }
    this.state = 'starting';
    const deadline = setTimeout(
      () => this.finish({ kind: 'failed', reason: 'start deadline exceeded' }),
      this.limits.startDeadlineMs,
    );
    try {
      return await Promise.race([this.handshake(), this.interrupted.promise]);
    } finally {
      clearTimeout(deadline);
    }
  }

  request(message: JSONRPCRequest): void {
    if (this.state !== 'running') {
      return;
    }
    const controller = new AbortController();
    this.requests.set(message.id, controller);
    void this.track(this.forward(message, controller.signal));
  }

  answer(message: Reply): void {
    if (this.state === 'running') {
      this.sendAuxiliary('answer', message);
    }
  }

  cancel(id: RequestId, params: Record<string, unknown> | undefined): void {
    const controller = this.requests.get(id);
    if (controller !== undefined) {
      this.requests.delete(id);
      this.postCancellation(id, params);
      controller.abort();
    }
  }

  stop(reason: StopReason): void {
    this.finish({ kind: 'local', reason });
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.pending.add(job);
    const release = () => this.pending.delete(job);
    // oxlint-disable-next-line promise/prefer-await-to-then -- release on either outcome without changing the tracked promise
    void job.then(release, release);
    return job;
  }

  private warn(reason: string) {
    this.options.log.warn(loggable(`HTTP Service ${this.options.serviceName}: ${reason}`));
  }

  private async handshake(): Promise<StartResult> {
    const { service, home } = this.options;
    const { signal } = this.startController;
    try {
      const bearer = await readServiceBearer(service, home);
      signal.throwIfAborted();
      if (bearer.kind === 'failed') {
        const reason = `bearer file ${expandHome(service.bearer_file, home)}: ${bearer.failure}`;
        this.warn(reason);
        this.finish({ kind: 'failed', reason });
        return { kind: 'failed', reason };
      }
      this.headers.set('Authorization', `Bearer ${bearer.secret}`);
      const result = await this.track(this.initialize(signal));
      signal.throwIfAborted();
      this.state = 'running';
      return { kind: 'started', result };
    } catch (error) {
      // Request libraries and the Service can put reflected credentials in errors.
      const fault = error instanceof LinkFaultError ? error : undefined;
      const reason = fault?.message ?? 'bad start answer';
      this.finish({ fault: fault?.kind, kind: 'failed', reason });
      return { kind: 'failed', reason };
    }
  }

  private async initialize(signal: AbortSignal) {
    const id = this.options.nextId();
    const response = await this.post(
      {
        id,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: MODGUD_INFO,
          protocolVersion: CHILD_PROTOCOL_VERSION,
        },
      },
      200,
      signal,
    );
    const sessionId = response.headers.get('Mcp-Session-Id');
    if (sessionId !== null) {
      this.headers.set('Mcp-Session-Id', sessionId);
    }
    const reply = await this.readReply(response, id, signal, () => undefined);
    const result = 'result' in reply ? parseChildInitializeResult(reply.result) : undefined;
    if (result === undefined) {
      throw new Error('Invalid initialize result');
    }
    signal.throwIfAborted();
    this.headers.set('MCP-Protocol-Version', result.protocolVersion);
    await this.accepted({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    return result;
  }

  private async forward(message: JSONRPCRequest, signal: AbortSignal) {
    const { id } = message;
    try {
      const response = await this.post(message, 200, signal);
      const reply = await this.readReply(response, id, signal, this.options.events.onMessage);
      signal.throwIfAborted();
      this.requests.delete(id);
      this.options.events.onMessage(reply);
    } catch (error) {
      if (signal.aborted || this.state !== 'running') {
        return;
      }
      if (error instanceof LinkFaultError) {
        this.selfStop(error);
        return;
      }
      this.requests.delete(id);
      if (typeof id === 'number') {
        this.options.events.onRequestFailed(id);
      }
    }
  }

  private async send(method: 'POST' | 'DELETE', signal: AbortSignal, message?: JSONRPCMessage) {
    const body = message === undefined ? null : JSON.stringify(message);
    try {
      return await fetch(this.options.service.url, {
        body,
        headers: this.headers,
        method,
        proxy: false,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED') {
        throw new LinkFaultError('refused', 'Service refused the connection');
      }
      throw error;
    }
  }

  private async post(message: JSONRPCMessage, expectedStatus: number, signal: AbortSignal) {
    const hasSession = this.headers.has('Mcp-Session-Id');
    const response = await this.send('POST', signal, message);
    if (signal.aborted || response.status !== expectedStatus) {
      await discardBody(response);
      signal.throwIfAborted();
      if (response.status === 401) {
        throw new LinkFaultError('unauthorized', 'Service refused the bearer');
      }
      if (response.status === 404 && hasSession) {
        throw new LinkFaultError('session ended', 'Service ended its MCP session');
      }
      throw new Error(`Unexpected HTTP status ${String(response.status)}`);
    }
    return response;
  }

  private async accepted(message: JSONRPCMessage, signal: AbortSignal) {
    const response = await this.post(message, 202, signal);
    if (response.body !== null) {
      for await (const chunk of response.body) {
        if (chunk.byteLength !== 0) {
          throw new Error('Expected an empty HTTP 202 answer');
        }
      }
    }
  }

  private async readReply(
    response: Response,
    id: RequestId,
    signal: AbortSignal,
    onMessage: UpstreamEvents['onMessage'],
  ) {
    const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (response.body !== null && mediaType === 'application/json') {
      const message = await readJson(response.body, this.limits.messageBytes);
      signal.throwIfAborted();
      return matchingReply(message, id);
    }
    if (response.body !== null && mediaType === 'text/event-stream') {
      for await (const text of eventData(response.body, this.limits.messageBytes)) {
        signal.throwIfAborted();
        const message = parseMessage(text);
        if (!('method' in message)) {
          return matchingReply(message, id);
        }
        onMessage(message);
      }
      throw new Error('SSE stream ended without a response');
    }
    await discardBody(response);
    throw new Error('Expected a JSON-RPC answer');
  }

  private postCancellation(id: RequestId, params?: Record<string, unknown>) {
    this.sendAuxiliary('cancellation', {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { ...params, requestId: id },
    });
  }

  private sendAuxiliary(kind: 'cancellation' | 'answer', message: JSONRPCMessage): void;
  private sendAuxiliary(kind: 'delete'): void;
  private sendAuxiliary(kind: Auxiliary, message?: JSONRPCMessage) {
    if (kind !== 'delete') {
      const limit =
        kind === 'cancellation' ? this.limits.cancellationsInFlight : this.limits.answersInFlight;
      let inFlight = 0;
      for (const operation of this.auxiliary.values()) {
        if (operation === kind) {
          inFlight += 1;
        }
      }
      if (inFlight >= limit) {
        this.warn(`too many ${kind}s in flight, dropping ${kind}`);
        return;
      }
    }
    const controller = new AbortController();
    this.auxiliary.set(controller, kind);
    void this.track(this.runAuxiliary(kind, controller, message));
  }

  private async runAuxiliary(
    kind: Auxiliary,
    controller: AbortController,
    message?: JSONRPCMessage,
  ) {
    const deadline = setTimeout(() => controller.abort('timeout'), this.limits.auxiliaryTimeoutMs);
    try {
      if (message === undefined) {
        await discardBody(await this.send('DELETE', controller.signal));
      } else {
        await this.accepted(message, controller.signal);
      }
    } catch (error) {
      if (this.state === 'running' && kind !== 'delete') {
        if (error instanceof LinkFaultError && !controller.signal.aborted) {
          this.selfStop(error);
        } else {
          this.warn(`bad ${kind} answer, dropping ${kind}`);
        }
      }
    } finally {
      clearTimeout(deadline);
      this.auxiliary.delete(controller);
    }
  }

  private selfStop(error: LinkFaultError) {
    this.finish({ fault: error.kind, kind: 'failed', reason: error.message });
    this.options.events.onStopped(error.message, error.kind !== 'session ended');
  }

  private finish(end: LinkEnd) {
    const shutdown = end.kind === 'local' && end.reason === 'shutdown';
    if (this.state === 'stopped') {
      return;
    }
    this.state = 'stopped';
    this.interrupted.resolve({ kind: 'failed', reason: end.reason });
    this.startController.abort();
    if (end.kind === 'local') {
      for (const id of this.requests.keys()) {
        this.postCancellation(id);
      }
    }
    for (const controller of this.requests.values()) {
      controller.abort();
    }
    this.requests.clear();

    const fault = end.kind === 'failed' ? end.fault : undefined;
    if (fault !== undefined) {
      this.abortAuxiliary();
    }
    if (
      this.headers.has('Mcp-Session-Id') &&
      fault !== 'unauthorized' &&
      fault !== 'session ended'
    ) {
      this.sendAuxiliary('delete');
    }
    if (shutdown) {
      // An abort in the same turn keeps Bun from dispatching the final
      // cancellation and DELETE fetches. Abort on the next timer turn
      // without waiting for any Service response.
      setTimeout(() => {
        this.abortAuxiliary();
        this.settled.resolve();
      }, 0);
    } else {
      // oxlint-disable-next-line promise/prefer-await-to-then -- settling never blocks stop or onStopped
      void Promise.allSettled(this.pending).then(() => this.settled.resolve());
    }
  }

  private abortAuxiliary() {
    for (const controller of this.auxiliary.keys()) {
      controller.abort();
    }
  }
}

export const createLink = (options: LinkOptions): Upstream => new Link(options);
