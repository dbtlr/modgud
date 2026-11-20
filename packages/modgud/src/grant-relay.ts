// One Grant's shared relay (ADR-0002, ADR-0005): everything a Grant keeps
// across runs of its Service, whatever serves it. It renumbers what
// identifies each Caller request, routes what the Service sends back to the
// Session it belongs to, answers what the Service asks of a Caller, and stops
// the run when idle, broken, or no longer wanted. How messages reach the
// Service is an Upstream's job (upstream.ts): GrantRelay drives one per run.
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

import { Backoff } from './backoff.ts';
import { CHILD_LOG_LIMIT, excerpt } from './log.ts';
import type { Log } from './log.ts';
import {
  emptyResult,
  ERRORS,
  errorResponse,
  notificationParam,
  renumbered,
  requestProgressToken,
  stillMatches,
} from './protocol.ts';
import type { ChildInitializeResult, Given, ProgressToken } from './protocol.ts';
import { ToolCallLimit, toolCallRefusal } from './tool-call-limit.ts';
import type { StopReason, Upstream, UpstreamFactory } from './upstream.ts';

// The bounds on a Grant's Service run and the requests it holds. Tests
// shorten them.
export type GrantLimits = {
  // How long a run has to complete Modgud's `initialize`. An Upstream
  // enforces it; whoever builds the Upstream (public-listener) passes it on,
  // and GrantRelay never reads it.
  startTimeoutMs: number;
  // The wait after one failed start, doubling up to `backoffMaxMs`.
  backoffBaseMs: number;
  backoffMaxMs: number;
  // How long a run must last for its failures to be forgotten.
  backoffResetMs: number;
  // The Caller requests a Grant may have waiting for the Service or in flight.
  requestsPerGrant: number;
  // How long a cancelled request keeps counting if the Service never answers.
  cancelledHoldMs: number;
};

export const GRANT_LIMITS: GrantLimits = {
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  backoffResetMs: 60_000,
  cancelledHoldMs: 60_000,
  requestsPerGrant: 64,
  startTimeoutMs: 30_000,
};

// What a Grant's relay needs of each Session it serves.
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

// Why a Caller's `initialize` cannot be answered: the Service could not start
// or is backing off, Modgud is shutting down, or the Grant ended.
export type Unavailable = 'failed' | 'grant ended' | 'shutdown';

export type Readiness = { kind: 'ready'; result: ChildInitializeResult } | { kind: Unavailable };

// A Caller request that waits for the Service to start.
type Waiting = { message: JSONRPCRequest; session: GrantSession };

// A Caller request forwarded to the Service, by its Upstream-side id.
type InFlight = {
  callerId: RequestId;
  callerToken: ProgressToken | undefined;
  upstreamId: number;
  upstreamToken: number | undefined;
  session: GrantSession;
};

// One run of the Grant's Service, from its start until it has stopped.
type Run = {
  upstream: Upstream;
  // Set once the Upstream has started.
  result: ChildInitializeResult | undefined;
  // Set once Modgud has decided to stop it; it sends the Upstream nothing more.
  stopping: boolean;
  timers: { idle?: Timer; reset?: Timer };
};

const sameId = (a: RequestId, b: RequestId) => typeof a === typeof b && a === b;

export type GrantRelayOptions = {
  grant: string;
  // The Service's log label, such as "norn child for <grant>".
  label: string;
  // How long a started run may pass without a message before it is stopped.
  idleTimeoutMs: number;
  limits: GrantLimits;
  log: Log;
  // The Service's max_tool_calls_per_minute (ADR-0006).
  maxToolCallsPerMinute: number;
  // The clock of the Grant's tool call window; tests move it.
  now?: () => number;
  service: string;
  // Creates the Upstream for each run.
  upstream: UpstreamFactory;
};

export class GrantRelay {
  readonly grant: string;
  readonly service: string;
  readonly #options: GrantRelayOptions;
  readonly #log: Log;
  readonly #limits: GrantLimits;
  readonly #backoff: Backoff;
  readonly #toolCalls: ToolCallLimit;
  // Every Session of the Grant, those still opening included.
  readonly #sessions = new Set<GrantSession>();
  // Callers of `ready`, waiting for the Service to start.
  #readyWaiters: ((readiness: Readiness) => void)[] = [];
  #waiting: Waiting[] = [];
  readonly #inFlight = new Map<number, InFlight>();
  readonly #progress = new Map<number, InFlight>();
  // Forwarded requests that were cancelled but still count against the limit
  // until the Service answers them, the run stops (unless its work outlives
  // the stop), or the hold passes.
  readonly #held = new Map<number, Timer>();
  // The `stopped` of every Upstream that has not yet settled.
  readonly #unsettled = new Set<Promise<void>>();
  // Upstream-side ids and progress tokens, never reused.
  #lastId = 0;
  #lastToken = 0;
  #run: Run | undefined;
  // Set once the Grant has ended or Modgud is shutting down: no run starts again.
  #ended: 'grant ended' | 'shutdown' | undefined;

  constructor(options: GrantRelayOptions) {
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
    this.#toolCalls = new ToolCallLimit({
      label: options.label,
      limit: options.maxToolCallsPerMinute,
      log: options.log,
      now: options.now ?? (() => performance.now()),
    });
  }

  get #label() {
    return this.#options.label;
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

  // Settles once the Service is running, starting it when needed, with its
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

  // Forwards a Caller request to the Service, starting it when needed, or
  // answers it with an error when the Grant holds too many requests or the
  // Service cannot start.
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
  // A waiting request is dropped; one in flight is cancelled on the Service.
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
  // forwarded, and those in flight are cancelled on the Service. Returns the
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

  // Ends the Grant's Sessions and stops its run, including one still
  // starting, for good: on shutdown, or when the Grant ends. Requests still
  // waiting fail without being forwarded. Resolves once the Upstream has
  // stopped.
  async end(kind: 'grant ended' | 'shutdown'): Promise<void> {
    if (this.#ended === undefined) {
      this.#ended = kind;
      this.#toolCalls.end();
      for (const session of this.#sessions) {
        session.end(kind === 'shutdown' ? 'shutdown' : 'authorization ended');
      }
      this.#failWaiting(kind);
      if (this.#run !== undefined) {
        this.#stop(this.#run, kind === 'shutdown' ? 'shutdown' : 'authorization ended');
      }
      // No run starts again, so nothing still counts against the limit.
      this.#releaseHeld();
    }
    await Promise.all(this.#unsettled);
  }

  // Starts a run when something waits for one and none is starting or
  // stopping. A stopping run is replaced only once its Upstream has stopped,
  // unless the Upstream restarts at once. During backoff, everything waiting
  // fails at once.
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
    // The Upstream's events fire only once it has started, after `run` is set.
    const run: Run = {
      result: undefined,
      stopping: false,
      timers: {},
      upstream: this.#options.upstream(
        {
          onMessage: (message) => this.#fromUpstream(run, message),
          onRequestFailed: (id) => this.#requestFailed(id),
          onStopped: (_reason, failure) => this.#stoppedByUpstream(run, failure),
        },
        () => this.#nextId(),
      ),
    };
    this.#run = run;
    const { stopped } = run.upstream;
    this.#unsettled.add(stopped);
    run.timers.reset = setTimeout(() => this.#backoff.reset(), this.#limits.backoffResetMs);
    const startHandled = this.#awaitStart(run);
    void this.#afterStopped(run, startHandled, stopped);
  }

  // Handles how the run's start ended. A failed start was already stopped by
  // the Upstream.
  async #awaitStart(run: Run) {
    const outcome = await run.upstream.start();
    if (outcome.kind === 'started') {
      this.#started(run, outcome.result);
    } else {
      this.#stoppedByUpstream(run, true);
    }
  }

  // Once the run's Upstream has stopped and GrantRelay has handled how its
  // start ended, the next run may start. A stop that settles before the start
  // result is read must not clear the run or demand another one first.
  async #afterStopped(run: Run, startHandled: Promise<void>, stopped: Promise<void>) {
    await startHandled;
    await stopped;
    this.#unsettled.delete(stopped);
    if (this.#run === run) {
      this.#run = undefined;
    }
    this.#demand();
  }

  #nextId() {
    this.#lastId += 1;
    return this.#lastId;
  }

  // The idle clock starts once the run has started and restarts with every
  // message in either direction.
  #armIdle(run: Run) {
    clearTimeout(run.timers.idle);
    if (run.result === undefined || run.stopping) {
      return;
    }
    run.timers.idle = setTimeout(() => this.#stop(run, 'idle'), this.#options.idleTimeoutMs);
  }

  // The Upstream has completed `initialize`. Before forwarding anything that
  // waits, it ends each Session that no longer matches the new result.
  #started(run: Run, result: ChildInitializeResult) {
    if (run.stopping) {
      return;
    }
    run.result = result;
    this.#armIdle(run);
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

  // Hands a Caller request to the run's Upstream. A tools/call past the
  // Grant's limit is answered with a tool error instead (ADR-0006).
  #send(run: Run, session: GrantSession, message: JSONRPCRequest) {
    if (message.method === 'tools/call') {
      const decision = this.#toolCalls.take();
      if (decision.kind === 'refuse') {
        session.deliver(
          toolCallRefusal(message.id, this.#toolCalls.limit, decision.retryAfterSeconds),
          { activity: true },
        );
        return;
      }
    }
    const callerToken = requestProgressToken(message);
    const entry: InFlight = {
      callerId: message.id,
      callerToken,
      session,
      upstreamId: this.#nextId(),
      upstreamToken: undefined,
    };
    if (callerToken !== undefined) {
      this.#lastToken += 1;
      entry.upstreamToken = this.#lastToken;
      this.#progress.set(entry.upstreamToken, entry);
    }
    this.#inFlight.set(entry.upstreamId, entry);
    this.#armIdle(run);
    run.upstream.request(renumbered(message, entry.upstreamId, entry.upstreamToken));
  }

  // The Upstream could not deliver a forwarded request: its Caller gets an
  // error.
  #requestFailed(id: number) {
    const entry = this.#inFlight.get(id);
    if (entry !== undefined) {
      this.#forget(entry);
      entry.session.deliver(errorResponse(entry.callerId, ERRORS.unreachable), { activity: true });
    }
  }

  // Releases a request's Upstream-side id and token for routing.
  #forget(entry: InFlight) {
    this.#inFlight.delete(entry.upstreamId);
    if (entry.upstreamToken !== undefined) {
      this.#progress.delete(entry.upstreamToken);
    }
  }

  // Keeps counting a request against the limit until the hold passes.
  #hold(id: number) {
    this.#held.set(
      id,
      setTimeout(() => this.#held.delete(id), this.#limits.cancelledHoldMs),
    );
  }

  // Stops every hold, so none of their timers lingers.
  #releaseHeld() {
    for (const timer of this.#held.values()) {
      clearTimeout(timer);
    }
    this.#held.clear();
  }

  // Cancels a forwarded request on the Service. Its id and token are released
  // at once, but it keeps counting against the limit until the Service answers
  // it, the run stops, or the hold passes.
  #cancelInFlight(entry: InFlight, notification: JSONRPCNotification | undefined) {
    this.#forget(entry);
    this.#hold(entry.upstreamId);
    const run = this.#run;
    if (run !== undefined && !run.stopping) {
      this.#armIdle(run);
      run.upstream.cancel(entry.upstreamId, notification?.params);
    }
  }

  #fromUpstream(run: Run, message: JSONRPCMessage) {
    if (run !== this.#run || run.stopping) {
      return;
    }
    this.#armIdle(run);
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      this.#response(message);
    } else if (isJSONRPCRequest(message)) {
      this.#serviceRequest(run, message);
    } else if (isJSONRPCNotification(message)) {
      this.#notification(message);
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

  // Modgud answers a Service's requests itself: the Service sees no client
  // capabilities, so only `ping` gets a result.
  #serviceRequest(run: Run, request: JSONRPCRequest) {
    this.#armIdle(run);
    if (request.method === 'ping') {
      run.upstream.answer(emptyResult(request.id));
      return;
    }
    this.#log.info(
      `${this.#label} asked for ${excerpt(request.method, 200)}, which Modgud does not offer.`,
    );
    run.upstream.answer(errorResponse(request.id, ERRORS.methodNotFound));
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

  // Fails everything waiting for the Service: an `initialize` learns why, and
  // a request on an open Session gets an error response.
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

  // Stops a run for Modgud's own reason, once: it asks the Upstream to stop
  // after settling what the run held.
  #stop(run: Run, reason: StopReason) {
    if (run.stopping) {
      return;
    }
    this.#settle(run, false);
    run.upstream.stop(reason);
    this.#detach(run);
  }

  // The Upstream stopped itself, or failed to start. It has already stopped
  // whatever it ran.
  #stoppedByUpstream(run: Run, failure: boolean) {
    if (run.stopping) {
      return;
    }
    this.#settle(run, failure);
    this.#detach(run);
  }

  // Marks a run stopping once: it sends the Upstream nothing more and fails
  // every request in flight. A failure counts toward backoff and fails what
  // waits for a run that never started. Anything else that waits starts the
  // next run once this one has stopped.
  #settle(run: Run, failure: boolean) {
    run.stopping = true;
    clearTimeout(run.timers.idle);
    clearTimeout(run.timers.reset);
    if (failure) {
      this.#backoff.failed();
    }
    const outlives = run.upstream.workOutlivesStop;
    for (const entry of this.#inFlight.values()) {
      this.#forget(entry);
      entry.session.deliver(errorResponse(entry.callerId, ERRORS.stopped), { activity: true });
      if (outlives) {
        this.#hold(entry.upstreamId);
      }
    }
    if (!outlives) {
      this.#releaseHeld();
    }
    if (run.result === undefined && (failure || this.#ended !== undefined)) {
      this.#failWaiting(this.#ended ?? 'failed');
    }
  }

  // An Upstream that restarts at once is replaced without waiting for its
  // `stopped`.
  #detach(run: Run) {
    if (run.upstream.restartsAtOnce && this.#run === run) {
      this.#run = undefined;
      this.#demand();
    }
  }
}
