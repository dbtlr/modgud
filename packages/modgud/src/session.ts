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

export type SessionEndReason = 'child exited' | 'deleted' | 'idle' | 'not initialized' | 'shutdown';

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

export type SessionOptions = {
  command: Pick<ServiceConfig, 'args' | 'command' | 'cwd' | 'idle_timeout_minutes'>;
  environment: Record<string, string>;
  grant: string;
  log: Log;
  onEnd: (session: Session, reason: SessionEndReason) => void;
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
  readonly #log: Log;
  readonly #onEnd: (session: Session, reason: SessionEndReason) => void;
  // Caller requests the Child has not answered, by key, and the progress
  // tokens they carry.
  readonly #inFlight = new Map<string, RequestId>();
  readonly #progress = new Map<string, RequestId>();
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #ended = false;

  private constructor(options: SessionOptions) {
    this.grant = options.grant;
    this.service = options.service;
    this.#log = options.log;
    this.#onEnd = options.onEnd;
    this.#idleMs = options.command.idle_timeout_minutes * 60_000;
    this.#child = new Child({
      args: options.command.args,
      command: options.command.command,
      cwd: options.command.cwd,
      environment: options.environment,
      onExit: () => void this.end('child exited'),
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
    }
    try {
      this.#child.send(message);
    } catch (error) {
      this.#log.warn(`${this.#label} could not write to the Child: ${String(error)}`);
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
      this.#log.warn(`${this.#label} dropped a message from the Child: ${String(error)}`);
    }
  }

  #settle(id: RequestId | undefined) {
    if (id === undefined || id === null) {
      return;
    }
    this.#inFlight.delete(key(id));
    for (const [token, requestId] of this.#progress) {
      if (requestId === id) {
        this.#progress.delete(token);
      }
    }
  }

  // Restarts the idle clock. A Session with a Caller request in flight is
  // never idle, so a long tool call is not cut off.
  #armIdleTimer() {
    clearTimeout(this.#idleTimer);
    if (this.#ended) {
      return;
    }
    this.#idleTimer = setTimeout(() => {
      if (this.#inFlight.size > 0) {
        this.#armIdleTimer();
      } else {
        void this.end('idle');
      }
    }, this.#idleMs);
  }

  // Ends the Session once, whatever ends it first: the Caller's DELETE, the
  // idle timeout, the Child exiting, or shutdown. Stops the Child.
  async end(reason: SessionEndReason): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    clearTimeout(this.#idleTimer);
    this.#onEnd(this, reason);
    await Promise.allSettled([this.#http.close(), this.#child.stop()]);
  }
}
