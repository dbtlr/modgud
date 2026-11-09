import { randomUUID } from 'node:crypto';

import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/server';

import { boundStream } from './bounded-stream.ts';
import type { GrantChild, GrantSession } from './grant-child.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import {
  ERRORS,
  errorResponse,
  notificationParam,
  ownAnswer,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol.ts';
import type { Given, initializeAnswer } from './protocol.ts';

export type SessionEndReason =
  | 'authorization ended'
  | 'child changed'
  | 'deleted'
  | 'evicted'
  | 'idle'
  | 'not initialized'
  | 'shutdown';

export type SessionEndHandler = (session: Session, reason: SessionEndReason) => void;

// The most output Modgud holds for one of a Caller's streams, not yet handed
// to the HTTP connection, when more arrives (ADR-0002).
export const STREAM_LIMIT_BYTES = 1024 * 1024;

// Orders Sessions by when each was last active.
let activityClock = 0;

export type SessionOptions = {
  child: GrantChild;
  // The id of the Grant that opened the Session.
  grant: string;
  // How long the Session lasts with no activity.
  idleMs: number;
  log: Log;
  // Called once, when the Session ends.
  onEnd: SessionEndHandler;
  service: string;
};

// One MCP Session: a Streamable HTTP server transport facing the Caller,
// served by its Grant's shared Child (ADR-0002). The Session answers its
// Caller's `initialize` from the Child's result, answers what Modgud answers
// itself, and hands every other request, and every cancellation, to the
// Child. It outlives the Child: it ends only when deleted, idle, evicted,
// changed out from under, or when its Grant ends or Modgud shuts down.
export class Session implements GrantSession {
  readonly id = randomUUID();
  readonly grant: string;
  readonly service: string;

  readonly #child: GrantChild;
  readonly #http: WebStandardStreamableHTTPServerTransport;
  readonly #idleMs: number;
  readonly #log: Log;
  readonly #onEnd: SessionEndHandler;
  #activity = 0;
  #ended = false;
  #given: Given | undefined;
  #idleTimer: Timer | undefined;
  // The answer to the Caller's initialize, until the transport hands it over.
  #initializeResult: Record<string, unknown> | undefined;

  constructor(options: SessionOptions) {
    this.grant = options.grant;
    this.service = options.service;
    this.#child = options.child;
    this.#idleMs = options.idleMs;
    this.#log = options.log;
    this.#onEnd = options.onEnd;
    this.#http = new WebStandardStreamableHTTPServerTransport({
      onsessionclosed: () => this.end('deleted'),
      sessionIdGenerator: () => this.id,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    });
    // The SDK's Transport interface takes its handlers as properties.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.#http.onmessage = (message) => this.#fromCaller(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.#http.onerror = (error) => {
      this.#log.warn(`${this.#label} HTTP transport error: ${loggable(error.message)}`);
    };
  }

  get #label() {
    return `${this.service} session ${this.id.slice(0, 8)}`;
  }

  get ended() {
    return this.#ended;
  }

  // What the Session was given at `initialize`; undefined while it opens.
  get given() {
    return this.#given;
  }

  get activity() {
    return this.#activity;
  }

  // Whether the Caller's initialize request was accepted, so the HTTP
  // transport now holds this Session's id.
  get initialized() {
    return this.#http.sessionId !== undefined;
  }

  // Answers the Caller's initialize request with the answer Modgud built from
  // the Child's result, which opens the Session.
  async open(
    request: Request,
    parsedBody: unknown,
    answer: ReturnType<typeof initializeAnswer>,
  ): Promise<Response> {
    await this.#http.start();
    this.#initializeResult = answer.result;
    const response = await this.#http.handleRequest(request, { parsedBody });
    if (this.initialized && !this.#ended) {
      this.#given = answer.given;
      this.#touch();
    }
    return this.#bounded(response);
  }

  // Answers one HTTP request on this Session.
  async handle(request: Request): Promise<Response> {
    this.#touch();
    return this.#bounded(await this.#http.handleRequest(request));
  }

  // An event-stream response whose body holds a bounded amount for a Caller
  // that stops reading it. Other responses pass through.
  #bounded(response: Response) {
    const type = response.headers.get('Content-Type') ?? '';
    if (response.body === null || !type.startsWith('text/event-stream')) {
      return response;
    }
    const body = boundStream(response.body, {
      limitBytes: STREAM_LIMIT_BYTES,
      onOverflow: () => {
        this.#log.warn(
          `${this.#label} ended a stream its Caller stopped reading, with more than 1 MiB unsent.`,
        );
      },
    });
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  // Activity is an HTTP request on the Session, or a message that answers or
  // reports on one of its requests. It restarts the idle clock.
  #touch() {
    activityClock += 1;
    this.#activity = activityClock;
    clearTimeout(this.#idleTimer);
    if (!this.#ended) {
      this.#idleTimer = setTimeout(() => this.end('idle'), this.#idleMs);
    }
  }

  #fromCaller(message: JSONRPCMessage) {
    if (isJSONRPCRequest(message)) {
      if (message.method === 'initialize') {
        const result = this.#initializeResult;
        this.#initializeResult = undefined;
        if (result !== undefined) {
          this.deliver({ id: message.id, jsonrpc: '2.0', result }, { activity: false });
        }
        return;
      }
      const answer = ownAnswer(message);
      if (answer === undefined) {
        this.#child.forward(this, message);
      } else {
        this.deliver(answer, { activity: true });
      }
    } else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
      const requestId = notificationParam(message, 'requestId');
      if (requestId !== undefined) {
        this.#child.cancel(this, requestId, message);
      }
    }
    // Every other Caller message has no Child counterpart: the Caller's
    // `notifications/initialized` is Modgud's to consume, and the Child sent
    // the Caller no requests to respond to.
  }

  // Sends a message to the Caller, on the stream of the request it relates
  // to, or on the GET stream when it relates to none. A message for a stream
  // that is gone is dropped.
  deliver(message: JSONRPCMessage, options: { activity: boolean; relatedRequestId?: RequestId }) {
    if (this.#ended) {
      return;
    }
    if (options.activity) {
      this.#touch();
    }
    void this.#send(message, options.relatedRequestId);
  }

  async #send(message: JSONRPCMessage, relatedRequestId: RequestId | undefined) {
    try {
      await this.#http.send(message, relatedRequestId === undefined ? {} : { relatedRequestId });
    } catch (error) {
      this.#log.warn(`${this.#label} dropped a message: ${loggable(String(error))}`);
    }
  }

  // Ends the Session once, whatever ends it first. Its waiting requests are
  // dropped and those in flight are cancelled on the Child; every request
  // still open gets an error response, and every stream it has open closes.
  end(reason: SessionEndReason) {
    if (this.#ended) {
      return;
    }
    const open = this.#child.release(this);
    for (const id of open) {
      this.deliver(errorResponse(id, ERRORS.sessionEnded), { activity: false });
    }
    this.#ended = true;
    clearTimeout(this.#idleTimer);
    void this.#http.close();
    this.#onEnd(this, reason);
  }
}
