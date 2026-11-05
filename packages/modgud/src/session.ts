import { randomUUID } from 'node:crypto';

import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/server';

import { Child } from './child.ts';
import type { ServiceConfig } from './config.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';

export type SessionEndReason =
  | 'child exited'
  | 'child protocol error'
  | 'deleted'
  | 'idle'
  | 'initialize timed out'
  | 'not initialized'
  | 'shutdown';

// How long a Child has to answer the Caller's initialize request before its
// Session ends.
export const INITIALIZE_TIMEOUT_MS = 30_000;

// A request id or progress token, as a map key: JSON-RPC lets either be a
// string or a number, and the two must not collide.
const key = (value: string | number) => `${typeof value}:${String(value)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The progress token a Caller request carries in `params._meta`, or the one a
// progress notification names in `params`.
const progressTokenOf = (message: JSONRPCMessage): string | number | undefined => {
  const params = 'params' in message ? message.params : undefined;
  if (!isRecord(params)) {
    return undefined;
  }
  const source = isJSONRPCNotification(message) ? params : params._meta;
  const token = isRecord(source) ? source.progressToken : undefined;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
};

export type SessionEndHandler = (
  session: Session,
  reason: SessionEndReason,
  stopped: Promise<void>,
) => void;

export type SessionOptions = {
  command: Pick<ServiceConfig, 'args' | 'command' | 'cwd' | 'idle_timeout_minutes'>;
  environment: Record<string, string>;
  // The id of the Grant that opened the Session.
  grant: string;
  initializeTimeoutMs: number;
  log: Log;
  // Called once, when the Session starts ending, with a promise that settles
  // once its Child has stopped.
  onEnd: SessionEndHandler;
  service: string;
};

// One MCP Session: a Streamable HTTP server transport facing the Caller and a
// stdio Child facing the Service, with every JSON-RPC message passed between
// them unchanged (ADR-0002). Modgud runs no MCP logic of its own here.
//
// The HTTP transport answers each Caller request on that request's own stream,
// so each message the Child sends is tied back to the Caller request it
// belongs to: a response by its id, a progress notification by its token, and
// any other message to the Caller request in flight when there is exactly
// one. Messages that belong to no single request go to the Caller's GET
// stream, when it has one open.
export class Session {
  readonly id = randomUUID();
  readonly grant: string;
  readonly service: string;

  readonly #child: Child;
  readonly #http: WebStandardStreamableHTTPServerTransport;
  readonly #idleMs: number;
  readonly #initializeTimeoutMs: number;
  readonly #log: Log;
  readonly #onEnd: SessionEndHandler;
  // Caller requests the Child has not answered and the Caller has not
  // cancelled, by key, and the progress tokens they carry.
  readonly #inFlight = new Map<string, RequestId>();
  readonly #progress = new Map<string, RequestId>();
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  // The Caller's initialize request, while the Child has not answered it.
  #initialize: { id: RequestId; timer: ReturnType<typeof setTimeout> } | undefined;
  #ended = false;
  // Settles once the Session has ended and its Child has stopped.
  readonly #stopped = Promise.withResolvers<void>();

  private constructor(options: SessionOptions) {
    this.grant = options.grant;
    this.service = options.service;
    this.#log = options.log;
    this.#onEnd = options.onEnd;
    this.#idleMs = options.command.idle_timeout_minutes * 60_000;
    this.#initializeTimeoutMs = options.initializeTimeoutMs;
    this.#child = new Child({
      args: options.command.args,
      command: options.command.command,
      cwd: options.command.cwd,
      environment: options.environment,
      onExit: () => void this.end('child exited'),
      onFatal: (error) => {
        this.#log.warn(
          `${this.#label} unreadable output from the Child: ${loggable(error.message)}`,
        );
        void this.end('child protocol error');
      },
      onMessage: (message) => void this.#fromChild(message),
      onStderr: (line) => {
        if (line.trim() !== '') {
          this.#log.info(`${this.#label} stderr: ${loggable(line)}`);
        }
      },
      onUnreadable: (error) => {
        this.#log.warn(
          `${this.#label} unreadable message from the Child: ${loggable(error.message)}`,
        );
      },
    });
    this.#http = new WebStandardStreamableHTTPServerTransport({
      onsessionclosed: () => void this.end('deleted'),
      sessionIdGenerator: () => this.id,
    });
  }

  // Starts the Child and wires the two transports together. Rejects when the
  // Child cannot be started.
  static async open(options: SessionOptions): Promise<Session> {
    const session = new Session(options);
    await session.#start();
    return session;
  }

  get #label() {
    return `${this.service} session ${this.id.slice(0, 8)}`;
  }

  async #start() {
    // The SDK's Transport interface takes its handlers as properties.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.#http.onmessage = (message) => void this.#fromCaller(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.#http.onerror = (error) => {
      this.#log.warn(`${this.#label} HTTP transport error: ${loggable(error.message)}`);
    };
    this.#child.start();
    await this.#http.start();
    this.#armIdleTimer();
  }

  // Whether the Caller's initialize request was accepted, so the HTTP
  // transport now holds this Session's id.
  get initialized() {
    return this.#http.sessionId !== undefined;
  }

  get ended() {
    return this.#ended;
  }

  // Answers one HTTP request on this Session.
  async handle(request: Request, parsedBody?: unknown): Promise<Response> {
    this.#armIdleTimer();
    return this.#http.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody });
  }

  async #fromCaller(message: JSONRPCMessage) {
    this.#armIdleTimer();
    if (isJSONRPCRequest(message)) {
      this.#inFlight.set(key(message.id), message.id);
      const token = progressTokenOf(message);
      if (token !== undefined) {
        this.#progress.set(key(token), message.id);
      }
      if (message.method === 'initialize' && this.#initialize === undefined) {
        this.#initialize = {
          id: message.id,
          timer: setTimeout(() => void this.end('initialize timed out'), this.#initializeTimeoutMs),
        };
      }
    } else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      // The Child sends no response to a cancelled request, so later messages
      // must not be tied to it.
      const requestId = isRecord(message.params) ? message.params.requestId : undefined;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        this.#settle(requestId);
      }
    }
    try {
      this.#child.send(message);
    } catch (error) {
      this.#log.warn(`${this.#label} could not write to the Child: ${loggable(String(error))}`);
    }
  }

  async #fromChild(message: JSONRPCMessage) {
    this.#armIdleTimer();
    let relatedRequestId: RequestId | undefined;
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      this.#settle(message.id);
    } else {
      const token = progressTokenOf(message);
      relatedRequestId =
        token === undefined || !isJSONRPCNotification(message)
          ? undefined
          : this.#progress.get(key(token));
      if (relatedRequestId === undefined && this.#inFlight.size === 1) {
        [relatedRequestId] = this.#inFlight.values();
      }
    }
    try {
      await this.#http.send(message, relatedRequestId === undefined ? {} : { relatedRequestId });
    } catch (error) {
      // The Caller's stream for this message is gone, for example after it
      // disconnected; the message has nowhere to go.
      this.#log.warn(`${this.#label} dropped a message from the Child: ${loggable(String(error))}`);
    }
  }

  #settle(id: RequestId | undefined) {
    if (id === undefined || id === null) {
      return;
    }
    this.#inFlight.delete(key(id));
    if (this.#initialize !== undefined && key(this.#initialize.id) === key(id)) {
      clearTimeout(this.#initialize.timer);
      this.#initialize = undefined;
    }
    for (const [token, requestId] of this.#progress) {
      if (requestId === id) {
        this.#progress.delete(token);
      }
    }
  }

  // Restarts the idle clock on any traffic: an HTTP request on the Session or
  // a message from either side. A request in flight does not hold it open,
  // because a request the Caller cancelled is never answered.
  #armIdleTimer() {
    clearTimeout(this.#idleTimer);
    if (this.#ended) {
      return;
    }
    this.#idleTimer = setTimeout(() => void this.end('idle'), this.#idleMs);
  }

  // Ends the Session once, whatever ends it first: the Caller's DELETE, the
  // idle timeout, a Child that exits, breaks the protocol, or never answers
  // initialize, or shutdown. Stops the Child. Every call returns the same
  // promise, which settles once the Child has stopped.
  end(reason: SessionEndReason): Promise<void> {
    if (!this.#ended) {
      this.#ended = true;
      clearTimeout(this.#idleTimer);
      clearTimeout(this.#initialize?.timer);
      // Stopping starts first, so a throwing onEnd cannot leave the Child running.
      void this.#stop();
      this.#onEnd(this, reason, this.#stopped.promise);
    }
    return this.#stopped.promise;
  }

  async #stop() {
    await Promise.allSettled([this.#http.close(), this.#child.stop()]);
    this.#stopped.resolve();
  }
}
