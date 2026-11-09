// One Grant's shared Child (ADR-0002): a Service process started on demand,
// initialized by Modgud itself, and shared by every Session the Grant opens.
// It renumbers what identifies each Caller request, routes what the Child
// sends back to the Session it belongs to, answers what the Child asks of a
// Caller, and stops the Child when idle, broken, or no longer wanted.
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/server';
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCResultResponse,
  JSONRPCNotification,
  JSONRPCRequest,
  RequestId,
} from '@modelcontextprotocol/server';

import packageMetadata from '../package.json';
import { Backoff } from './backoff.ts';
import { Child } from './child.ts';
import type { ExitStatus } from './child.ts';
import type { ServiceConfig } from './config.ts';
import { CHILD_LOG_LIMIT, excerpt, loggable } from './log.ts';
import type { Log } from './log.ts';
import {
  CHILD_PROTOCOL_VERSION,
  emptyResult,
  ERRORS,
  errorResponse,
  notificationParam,
  parseChildInitializeResult,
  renumbered,
  requestProgressToken,
  stillMatches,
} from './protocol.ts';
import type { ChildInitializeResult, Given, ProgressToken } from './protocol.ts';

// The bounds on a Grant's Child and the requests it holds. Tests shorten them.
export type ChildLimits = {
  // How long a Child has to answer Modgud's `initialize`.
  initializeTimeoutMs: number;
  // The wait after one failed start, doubling up to `backoffMaxMs`.
  backoffBaseMs: number;
  backoffMaxMs: number;
  // How long a Child must run for its failures to be forgotten.
  backoffResetMs: number;
  // The Caller requests a Grant may have waiting for its Child or in flight.
  requestsPerGrant: number;
  // How long a cancelled request keeps counting if the Child never answers.
  cancelledHoldMs: number;
};

export const CHILD_LIMITS: ChildLimits = {
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  backoffResetMs: 60_000,
  cancelledHoldMs: 60_000,
  initializeTimeoutMs: 30_000,
  requestsPerGrant: 64,
};

const MODGUD_INFO = { name: 'modgud', version: packageMetadata.version };

// What a Grant's Child needs of each Session it serves.
export type GrantSession = {
  readonly ended: boolean;
  // What the Session was given at `initialize`; undefined while it opens.
  readonly given: Given | undefined;
  // Higher for a Session active more recently.
  readonly activity: number;
  // Sends a message to the Caller: on the stream of the request it relates
  // to, or on the GET stream. A message that answers or reports on one of
  // the Session's requests counts as activity.
  deliver: (
    message: JSONRPCMessage,
    options: { activity: boolean; relatedRequestId?: RequestId },
  ) => void;
  end: (reason: 'authorization ended' | 'child changed' | 'evicted' | 'shutdown') => void;
};

// Why a Caller's `initialize` cannot be answered: the Child could not start
// or is backing off, Modgud is shutting down, or the Grant ended.
export type Unavailable = 'failed' | 'grant ended' | 'shutdown';

export type Readiness = { kind: 'ready'; result: ChildInitializeResult } | { kind: Unavailable };

// A Caller request that waits for the Child to start.
type Waiting = { message: JSONRPCRequest; session: GrantSession };

// A Caller request forwarded to the Child, by its Child-side id.
type InFlight = {
  callerId: RequestId;
  callerToken: ProgressToken | undefined;
  childId: number;
  childToken: number | undefined;
  session: GrantSession;
};

// One process of the Grant's Child, from its start until it has exited.
type Run = {
  process: Child;
  exited: PromiseWithResolvers<void>;
  initializeId: number;
  // Set once the Child has answered `initialize`.
  result: ChildInitializeResult | undefined;
  // Set once Modgud has decided to stop it; it sends the Child nothing more.
  stopping: boolean;
  timers: { idle?: Timer; initialize?: Timer; reset?: Timer };
};

const sameId = (a: RequestId, b: RequestId) => typeof a === typeof b && a === b;

const describeExit = ({ code, signal }: ExitStatus) =>
  signal === null ? `exited with status ${String(code)}` : `exited on ${signal}`;

export type GrantChildOptions = {
  command: Pick<ServiceConfig, 'args' | 'command' | 'cwd' | 'idle_timeout_minutes'>;
  // The Child's environment, built at each start.
  environment: () => Record<string, string>;
  grant: string;
  // A short name for the Grant in log lines.
  grantLabel: string;
  limits: ChildLimits;
  log: Log;
  service: string;
};

export class GrantChild {
  readonly grant: string;
  readonly service: string;
  readonly #options: GrantChildOptions;
  readonly #log: Log;
  readonly #limits: ChildLimits;
  readonly #backoff: Backoff;
  // Every Session of the Grant, those still opening included.
  readonly #sessions = new Set<GrantSession>();
  // Callers of `ready`, waiting for the Child to start.
  #readyWaiters: ((readiness: Readiness) => void)[] = [];
  #waiting: Waiting[] = [];
  readonly #inFlight = new Map<number, InFlight>();
  readonly #progress = new Map<number, InFlight>();
  // Forwarded requests that were cancelled but still count against the limit
  // until the Child answers them, the Child stops, or the hold passes.
  readonly #held = new Map<number, Timer>();
  // Child-side ids and progress tokens, never reused.
  #lastId = 0;
  #lastToken = 0;
  #run: Run | undefined;
  // Set once the Grant has ended or Modgud is shutting down: no Child starts again.
  #ended: 'grant ended' | 'shutdown' | undefined;

  constructor(options: GrantChildOptions) {
    this.#options = options;
    this.grant = options.grant;
    this.service = options.service;
    this.#log = options.log;
    this.#limits = options.limits;
    this.#backoff = new Backoff({
      baseMs: options.limits.backoffBaseMs,
      maxMs: options.limits.backoffMaxMs,
      now: () => performance.now(),
    });
  }

  get #label() {
    return `${this.service} child for ${this.#options.grantLabel}`;
  }

  // Adds a Session that is opening. At the limit, it first ends the Grant's
  // least recently active open Session as evicted. Returns false, adding
  // nothing, when every Session of the Grant is still opening.
  admit(session: GrantSession, limit: number): boolean {
    if (this.#sessions.size >= limit) {
      let oldest: GrantSession | undefined;
      for (const candidate of this.#sessions) {
        if (
          candidate.given !== undefined &&
          (oldest === undefined || candidate.activity < oldest.activity)
        ) {
          oldest = candidate;
        }
      }
      if (oldest === undefined) {
        return false;
      }
      oldest.end('evicted');
    }
    this.#sessions.add(session);
    return true;
  }

  // Settles once the Child is running, starting it when needed, with its
  // initialize result, or with why it is unavailable.
  ready(): Promise<Readiness> {
    if (this.#ended !== undefined) {
      return Promise.resolve({ kind: this.#ended });
    }
    const result = this.#run !== undefined && !this.#run.stopping ? this.#run.result : undefined;
    if (result !== undefined) {
      return Promise.resolve({ kind: 'ready', result });
    }
    const ready = Promise.withResolvers<Readiness>();
    this.#readyWaiters.push(ready.resolve);
    this.#demand();
    return ready.promise;
  }

  // Forwards a Caller request to the Child, starting it when needed, or
  // answers it with an error when the Grant holds too many requests or the
  // Child cannot start.
  forward(session: GrantSession, message: JSONRPCRequest) {
    // An ended Session's work is never forwarded (ADR-0002).
    if (session.ended) {
      return;
    }
    if (this.#ended !== undefined) {
      session.deliver(errorResponse(message.id, ERRORS.unavailable), { activity: true });
      return;
    }
    if (
      this.#waiting.length + this.#inFlight.size + this.#held.size >=
      this.#limits.requestsPerGrant
    ) {
      this.#log.warn(
        `${this.#label} refused a request: ${String(this.#limits.requestsPerGrant)} are open.`,
      );
      session.deliver(errorResponse(message.id, ERRORS.tooManyRequests), { activity: true });
      return;
    }
    const run = this.#run;
    if (run?.result !== undefined && !run.stopping) {
      this.#send(run, session, message);
      return;
    }
    this.#waiting.push({ message, session });
    this.#demand();
  }

  // A Caller's `notifications/cancelled` for one of its Session's requests.
  // A waiting request is dropped; one in flight is cancelled on the Child.
  // A cancellation that names neither is dropped.
  cancel(session: GrantSession, callerId: RequestId, notification: JSONRPCNotification) {
    const waiting = this.#waiting.findIndex(
      (entry) => entry.session === session && sameId(entry.message.id, callerId),
    );
    if (waiting !== -1) {
      this.#waiting.splice(waiting, 1);
      return;
    }
    for (const entry of this.#inFlight.values()) {
      if (entry.session === session && sameId(entry.callerId, callerId)) {
        this.#cancelInFlight(entry, notification);
        return;
      }
    }
  }

  // Drops a Session's work as it ends: its waiting requests are never
  // forwarded, and those in flight are cancelled on the Child. Returns the
  // Caller ids of both, which are still open on the Session.
  release(session: GrantSession): RequestId[] {
    this.#sessions.delete(session);
    const open: RequestId[] = [];
    this.#waiting = this.#waiting.filter((entry) => {
      if (entry.session !== session) {
        return true;
      }
      open.push(entry.message.id);
      return false;
    });
    for (const entry of this.#inFlight.values()) {
      if (entry.session === session) {
        open.push(entry.callerId);
        this.#cancelInFlight(entry, undefined);
      }
    }
    return open;
  }

  // Ends the Grant's Sessions and stops its Child, including one still
  // starting, for good: on shutdown, or when the Grant ends. Requests still
  // waiting fail without being forwarded. Resolves once the Child has exited.
  async end(kind: 'grant ended' | 'shutdown'): Promise<void> {
    if (this.#ended === undefined) {
      this.#ended = kind;
      for (const session of this.#sessions) {
        session.end(kind === 'shutdown' ? 'shutdown' : 'authorization ended');
      }
      this.#failWaiting(kind);
      if (this.#run !== undefined) {
        this.#stop(this.#run, kind === 'shutdown' ? 'shutdown' : 'authorization ended', false);
      }
    }
    await this.#run?.exited.promise;
  }

  // Starts a Child when something waits for one and none is starting or
  // stopping. A stopping Child is replaced only once it has exited. During
  // backoff, everything waiting fails at once.
  #demand() {
    if (this.#run !== undefined || this.#ended !== undefined) {
      return;
    }
    if (this.#readyWaiters.length === 0 && this.#waiting.length === 0) {
      return;
    }
    if (this.#backoff.blocked) {
      this.#failWaiting('failed');
      return;
    }
    this.#start();
  }

  #start() {
    const { args, command, cwd } = this.#options.command;
    // The callbacks run only once the process has started, after `run` is set.
    const process = new Child({
      args,
      command,
      cwd,
      environment: this.#options.environment(),
      onExit: (status) => this.#exited(run, status),
      onFatal: (error) => {
        this.#log.warn(`${this.#label} unreadable output: ${loggable(error.message)}`);
        this.#stop(run, 'unreadable output', true);
      },
      onMessage: (message) => this.#fromChild(run, message),
      onStderr: (line) => {
        if (line.trim() !== '') {
          this.#log.info(`${this.#label} stderr: ${excerpt(line, CHILD_LOG_LIMIT)}`);
        }
      },
      onUnreadable: (error) => {
        this.#log.warn(`${this.#label} unreadable message: ${loggable(error.message)}`);
      },
    });
    const run: Run = {
      exited: Promise.withResolvers<void>(),
      initializeId: this.#nextId(),
      process,
      result: undefined,
      stopping: false,
      timers: {},
    };
    try {
      run.process.start();
    } catch (error) {
      this.#log.warn(`${this.#label} could not start: ${loggable(String(error))}`);
      this.#backoff.failed();
      this.#failWaiting('failed');
      return;
    }
    this.#run = run;
    this.#log.info(`${this.#label} started, pid ${String(run.process.pid)}.`);
    run.timers.initialize = setTimeout(
      () => this.#stop(run, 'initialize timed out', true),
      this.#limits.initializeTimeoutMs,
    );
    run.timers.reset = setTimeout(() => this.#backoff.reset(), this.#limits.backoffResetMs);
    void this.#write(run, {
      id: run.initializeId,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: MODGUD_INFO,
        protocolVersion: CHILD_PROTOCOL_VERSION,
      },
    });
  }

  #nextId() {
    this.#lastId += 1;
    return this.#lastId;
  }

  // Writes to the Child unless Modgud has decided to stop it, and restarts
  // its idle clock. Resolves to whether the write succeeded.
  async #write(run: Run, message: JSONRPCMessage): Promise<boolean> {
    if (run.stopping) {
      return false;
    }
    this.#armIdle(run);
    try {
      await run.process.send(message);
      return true;
    } catch (error) {
      this.#log.warn(`${this.#label} could not write to the Child: ${loggable(String(error))}`);
      return false;
    }
  }

  // The idle clock starts once the Child has answered `initialize` and
  // restarts with every message in either direction.
  #armIdle(run: Run) {
    clearTimeout(run.timers.idle);
    if (run.result === undefined || run.stopping) {
      return;
    }
    run.timers.idle = setTimeout(
      () => this.#stop(run, 'idle', false),
      this.#options.command.idle_timeout_minutes * 60_000,
    );
  }

  #send(run: Run, session: GrantSession, message: JSONRPCRequest) {
    const callerToken = requestProgressToken(message);
    const entry: InFlight = {
      callerId: message.id,
      callerToken,
      childId: this.#nextId(),
      childToken: undefined,
      session,
    };
    if (callerToken !== undefined) {
      this.#lastToken += 1;
      entry.childToken = this.#lastToken;
      this.#progress.set(entry.childToken, entry);
    }
    this.#inFlight.set(entry.childId, entry);
    void this.#forwardWritten(run, entry, renumbered(message, entry.childId, entry.childToken));
  }

  // Writes a forwarded request, answering it with an error when the Child
  // cannot receive it.
  async #forwardWritten(run: Run, entry: InFlight, message: JSONRPCRequest) {
    const written = await this.#write(run, message);
    if (!written && this.#inFlight.get(entry.childId) === entry) {
      this.#forget(entry);
      entry.session.deliver(errorResponse(entry.callerId, ERRORS.unreachable), { activity: true });
    }
  }

  // Releases a request's Child-side id and token for routing.
  #forget(entry: InFlight) {
    this.#inFlight.delete(entry.childId);
    if (entry.childToken !== undefined) {
      this.#progress.delete(entry.childToken);
    }
  }

  // Cancels a forwarded request on the Child. Its id and token are released
  // at once, but it keeps counting against the limit until the Child answers
  // it, the Child stops, or the hold passes.
  #cancelInFlight(entry: InFlight, notification: JSONRPCNotification | undefined) {
    this.#forget(entry);
    this.#held.set(
      entry.childId,
      setTimeout(() => this.#held.delete(entry.childId), this.#limits.cancelledHoldMs),
    );
    if (this.#run !== undefined) {
      void this.#write(this.#run, {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { ...notification?.params, requestId: entry.childId },
      });
    }
  }

  #fromChild(run: Run, message: JSONRPCMessage) {
    if (run !== this.#run || run.stopping) {
      return;
    }
    this.#armIdle(run);
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      if (run.result === undefined && message.id === run.initializeId) {
        this.#initialized(run, message);
      } else {
        this.#response(message);
      }
    } else if (isJSONRPCRequest(message)) {
      this.#childRequest(run, message);
    } else if (isJSONRPCNotification(message)) {
      this.#notification(message);
    }
  }

  // The Child's answer to Modgud's `initialize`. Before forwarding anything
  // that waits, it ends each Session that no longer matches the new Child.
  #initialized(run: Run, message: JSONRPCMessage) {
    const result = isJSONRPCResultResponse(message)
      ? parseChildInitializeResult(message.result)
      : undefined;
    if (result === undefined) {
      this.#log.warn(
        `${this.#label} answered initialize with ${excerpt(JSON.stringify(message), CHILD_LOG_LIMIT)}`,
      );
      this.#stop(
        run,
        isJSONRPCErrorResponse(message) ? 'initialize failed' : 'unsupported initialize result',
        true,
      );
      return;
    }
    clearTimeout(run.timers.initialize);
    run.result = result;
    this.#armIdle(run);
    void this.#write(run, { jsonrpc: '2.0', method: 'notifications/initialized' });
    for (const session of this.#sessions) {
      if (session.given !== undefined && !stillMatches(session.given, result)) {
        session.end('child changed');
      }
    }
    const readyWaiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const resolve of readyWaiters) {
      resolve({ kind: 'ready', result });
    }
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const entry of waiting) {
      this.#send(run, entry.session, entry.message);
    }
  }

  #response(message: JSONRPCErrorResponse | JSONRPCResultResponse) {
    const { id } = message;
    if (typeof id === 'number' && this.#held.has(id)) {
      clearTimeout(this.#held.get(id));
      this.#held.delete(id);
      return;
    }
    const entry = typeof id === 'number' ? this.#inFlight.get(id) : undefined;
    if (entry === undefined) {
      this.#log.warn(
        `${this.#label} sent a response to no open request: id ${excerpt(JSON.stringify(id), CHILD_LOG_LIMIT)}`,
      );
      return;
    }
    this.#forget(entry);
    entry.session.deliver({ ...message, id: entry.callerId }, { activity: true });
  }

  // Modgud answers a Child's requests itself: the Child sees no client
  // capabilities, so only `ping` gets a result.
  #childRequest(run: Run, request: JSONRPCRequest) {
    if (request.method === 'ping') {
      void this.#write(run, emptyResult(request.id));
      return;
    }
    this.#log.info(
      `${this.#label} asked for ${excerpt(request.method, 200)}, which Modgud does not offer.`,
    );
    void this.#write(run, errorResponse(request.id, ERRORS.methodNotFound));
  }

  #notification(message: JSONRPCNotification) {
    switch (message.method) {
      case 'notifications/progress': {
        const token = notificationParam(message, 'progressToken');
        const entry = typeof token === 'number' ? this.#progress.get(token) : undefined;
        if (entry !== undefined && entry.callerToken !== undefined) {
          entry.session.deliver(
            { ...message, params: { ...message.params, progressToken: entry.callerToken } },
            { activity: true, relatedRequestId: entry.callerId },
          );
        }
        return;
      }
      case 'notifications/cancelled': {
        // It names a request Modgud has already answered.
        return;
      }
      case 'notifications/prompts/list_changed':
      case 'notifications/resources/list_changed':
      case 'notifications/tools/list_changed': {
        for (const session of this.#sessions) {
          if (session.given !== undefined && !session.ended) {
            session.deliver(message, { activity: false });
          }
        }
        return;
      }
      default: {
        this.#log.info(
          `${this.#label} notification: ${excerpt(JSON.stringify(message), CHILD_LOG_LIMIT)}`,
        );
      }
    }
  }

  // Fails everything waiting for a Child: an `initialize` learns why, and a
  // request on an open Session gets an error response.
  #failWaiting(reason: Unavailable) {
    const readyWaiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const resolve of readyWaiters) {
      resolve({ kind: reason });
    }
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const entry of waiting) {
      entry.session.deliver(errorResponse(entry.message.id, ERRORS.unavailable), {
        activity: true,
      });
    }
  }

  // Stops a Child once: it sends the Child nothing more, fails every request
  // in flight, and stops the process, killing it 2 seconds after SIGTERM. A
  // failure counts toward backoff and fails what waits for a Child that never
  // started. Anything else that waits starts the next Child once this one has
  // exited.
  #stop(run: Run, reason: string, failure: boolean) {
    if (run.stopping) {
      return;
    }
    run.stopping = true;
    clearTimeout(run.timers.idle);
    clearTimeout(run.timers.initialize);
    clearTimeout(run.timers.reset);
    this.#log.info(`${this.#label} stopped: ${reason}.`);
    if (failure) {
      this.#backoff.failed();
    }
    for (const entry of this.#inFlight.values()) {
      this.#forget(entry);
      entry.session.deliver(errorResponse(entry.callerId, ERRORS.stopped), { activity: true });
    }
    for (const timer of this.#held.values()) {
      clearTimeout(timer);
    }
    this.#held.clear();
    if (run.result === undefined && (failure || this.#ended !== undefined)) {
      this.#failWaiting(this.#ended ?? 'failed');
    }
    void run.process.stop();
  }

  #exited(run: Run, status: ExitStatus) {
    if (!run.stopping) {
      this.#stop(run, describeExit(status), true);
    }
    if (this.#run === run) {
      this.#run = undefined;
    }
    run.exited.resolve();
    this.#demand();
  }
}
