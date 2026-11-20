// What serves a Grant for one run: one Child process (ADR-0002) or one Link
// to an HTTP Service (ADR-0005). GrantRelay owns everything a Grant keeps
// across runs: its Sessions, the request limit and cancelled holds,
// renumbering, routing, idle timing, and backoff. It drives one Upstream at a
// time through this interface, and the Upstream owns only how messages reach
// the Service and come back.
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse,
  RequestId,
} from '@modelcontextprotocol/server';

import type { ChildInitializeResult } from './protocol.ts';

// How a start ended. A failed start counts toward backoff; its reason goes to
// the log and never to a Caller.
export type StartResult =
  | { kind: 'started'; result: ChildInitializeResult }
  | { kind: 'failed'; reason: string };

// Why GrantRelay stops an Upstream. An Upstream that stops itself reports
// that through `onStopped` instead.
export type StopReason = 'authorization ended' | 'idle' | 'shutdown';

// What an Upstream reports to GrantRelay. None of them fire after GrantRelay
// has called `stop`.
export type UpstreamEvents = {
  // A message the Service sent, other than the answers to Modgud's own start
  // requests: a response or progress for a forwarded request, a request, or a
  // notification. It may arrive before `start` resolves. Its ids are the
  // Upstream-side ids GrantRelay assigned.
  onMessage: (message: JSONRPCMessage) => void;
  // One forwarded request failed without stopping the Upstream, such as a
  // write that failed or a bad HTTP answer. GrantRelay answers its Caller
  // with a generic error.
  onRequestFailed: (id: number) => void;
  // The Upstream stopped itself after it started: a Child exited or wrote
  // unreadable output, or a Link's Service refused the connection, answered
  // 401, or answered 404 on its session id. `failure` says whether it counts
  // toward backoff.
  onStopped: (reason: string, failure: boolean) => void;
};

export type Upstream = {
  // Whether GrantRelay may start the next run before this one's `stop` or
  // self-stop has settled. A Child's successor waits for its process group to
  // stop; a Link's may start at once.
  readonly restartsAtOnce: boolean;
  // Whether a forwarded request still in flight when this run stops keeps
  // counting against the Grant's request limit for the cancelled hold. A
  // stopped Child's work stops with it; a stopped Link's may still finish on
  // the Service.
  readonly workOutlivesStop: boolean;
  // Settles once the run has fully stopped, however it stopped: a Child's
  // process group has stopped, or a Link's last request to the Service has
  // settled.
  readonly stopped: Promise<void>;
  // Starts the run and completes Modgud's own `initialize` handshake within
  // the start deadline. Called once. After `stop`, it resolves as failed.
  start: () => Promise<StartResult>;
  // Sends a forwarded Caller request, already renumbered.
  request: (message: JSONRPCRequest) => void;
  // Sends Modgud's answer to a request the Service made, such as `ping`.
  answer: (message: JSONRPCErrorResponse | JSONRPCResultResponse) => void;
  // Cancels a forwarded request by its Upstream-side id: it sends the
  // Service `notifications/cancelled` with `params` and that id, and a Link
  // then aborts the request's POST.
  cancel: (id: RequestId, params: Record<string, unknown> | undefined) => void;
  // Stops the run for GrantRelay's reason, including one still starting. It
  // sends the Service nothing further for Caller work, except what stopping
  // itself sends, such as a Link's cancellations and DELETE.
  stop: (reason: StopReason) => void;
};

// Creates the Upstream for one run. `nextId` hands out Upstream-side request
// ids that GrantRelay never reuses, for the Upstream's own requests such as
// `initialize`.
export type UpstreamFactory = (events: UpstreamEvents, nextId: () => number) => Upstream;
