// The Upstream for a process Service (ADR-0002): one Child from its spawn
// until it has exited. It completes Modgud's own `initialize` handshake,
// writes and reads the Child's messages, logs what the Child reports on
// stderr, and stops the process. Everything a Grant keeps across Children
// stays in GrantRelay.
import { isJSONRPCErrorResponse, isJSONRPCResultResponse } from '@modelcontextprotocol/server';
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse,
  RequestId,
} from '@modelcontextprotocol/server';

import packageMetadata from '../package.json';
import { Child } from './child.ts';
import type { ExitStatus } from './child.ts';
import type { ProcessServiceConfig } from './config.ts';
import { CHILD_LOG_LIMIT, excerpt, loggable } from './log.ts';
import type { Log } from './log.ts';
import { CHILD_PROTOCOL_VERSION, parseChildInitializeResult } from './protocol.ts';
import type {
  StartResult,
  StopReason,
  Upstream,
  UpstreamEvents,
  UpstreamFactory,
} from './upstream.ts';

const MODGUD_INFO = { name: 'modgud', version: packageMetadata.version };

const describeExit = ({ code, signal }: ExitStatus) =>
  signal === null ? `exited with status ${String(code)}` : `exited on ${signal}`;

export type ChildUpstreamOptions = {
  command: Pick<ProcessServiceConfig, 'args' | 'command' | 'cwd'>;
  // The Child's environment, built at each start.
  environment: () => Record<string, string>;
  // The Service's log label, such as "norn child for <grant>".
  label: string;
  log: Log;
  // How long the Child has to answer Modgud's `initialize`.
  startTimeoutMs: number;
};

// Creates the Upstream for each run of a process Service.
export const createChildUpstream =
  (options: ChildUpstreamOptions): UpstreamFactory =>
  (events, nextId) =>
    new ChildUpstream(options, events, nextId);

class ChildUpstream implements Upstream {
  readonly restartsAtOnce = false;
  readonly workOutlivesStop = false;
  readonly stopped: Promise<void>;
  readonly #options: ChildUpstreamOptions;
  readonly #events: UpstreamEvents;
  readonly #process: Child;
  readonly #exited = Promise.withResolvers<void>();
  readonly #started = Promise.withResolvers<StartResult>();
  readonly #initializeId: number;
  #initializeTimer: Timer | undefined;
  // Set once the Child has answered `initialize` successfully.
  #initialized = false;
  // Set once GrantRelay has handled the start; messages that arrive in
  // between wait for it, so it sees them with the run started.
  #handedOver = false;
  // Set once the run is stopping or has stopped; it sends the Child nothing
  // more and reports nothing further.
  #stopping = false;

  constructor(options: ChildUpstreamOptions, events: UpstreamEvents, nextId: () => number) {
    this.#options = options;
    this.#events = events;
    this.stopped = this.#exited.promise;
    const { args, command, cwd } = options.command;
    const { label, log } = options;
    this.#process = new Child({
      args,
      command,
      cwd,
      environment: options.environment(),
      onExit: (status) => {
        this.#stopItself(describeExit(status));
        this.#exited.resolve();
      },
      onFatal: (error) => {
        log.warn(`${label} unreadable output: ${loggable(error.message)}`);
        this.#stopItself('unreadable output');
      },
      onMessage: (message) => this.#fromChild(message),
      onStderr: (line) => {
        if (line.trim() !== '') {
          log.info(`${label} stderr: ${excerpt(line, CHILD_LOG_LIMIT)}`);
        }
      },
      onUnreadable: (error) => {
        log.warn(`${label} unreadable message: ${loggable(error.message)}`);
      },
    });
    this.#initializeId = nextId();
  }

  // Spawns the Child and sends `initialize`. It resolves once the Child has
  // answered it with a result Modgud can serve, or failed.
  start(): Promise<StartResult> {
    const { label, log } = this.#options;
    if (this.#stopping) {
      return Promise.resolve({ kind: 'failed', reason: 'stopped' });
    }
    try {
      this.#process.start();
    } catch (error) {
      log.warn(`${label} could not start: ${loggable(String(error))}`);
      this.#stopping = true;
      this.#exited.resolve();
      return Promise.resolve({ kind: 'failed', reason: 'could not start' });
    }
    log.info(`${label} started, pid ${String(this.#process.pid)}.`);
    this.#initializeTimer = setTimeout(
      () => this.#failStart('initialize timed out'),
      this.#options.startTimeoutMs,
    );
    void this.#write({
      id: this.#initializeId,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: MODGUD_INFO,
        protocolVersion: CHILD_PROTOCOL_VERSION,
      },
    });
    return this.#started.promise;
  }

  request(message: JSONRPCRequest) {
    void this.#writeRequest(message);
  }

  answer(message: JSONRPCErrorResponse | JSONRPCResultResponse) {
    void this.#write(message);
  }

  cancel(id: RequestId, params: Record<string, unknown> | undefined) {
    void this.#write({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { ...params, requestId: id },
    });
  }

  // Stops the Child for GrantRelay's reason: SIGTERM, then SIGKILL.
  stop(reason: StopReason) {
    this.#halt(reason);
  }

  // Writes a forwarded request, reporting it failed when the write fails.
  async #writeRequest(message: JSONRPCRequest) {
    const written = await this.#write(message);
    if (!written && !this.#stopping && typeof message.id === 'number') {
      this.#events.onRequestFailed(message.id);
    }
  }

  // Writes to the Child unless the run is stopping. Resolves to whether the
  // write succeeded.
  async #write(message: JSONRPCMessage): Promise<boolean> {
    if (this.#stopping) {
      return false;
    }
    try {
      await this.#process.send(message);
      return true;
    } catch (error) {
      this.#options.log.warn(
        `${this.#options.label} could not write to the Child: ${loggable(String(error))}`,
      );
      return false;
    }
  }

  // Stops the Child once, so it sends it nothing more and reports nothing
  // further. A start still waiting fails with the reason.
  #halt(reason: string) {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    clearTimeout(this.#initializeTimer);
    this.#options.log.info(`${this.#options.label} stopped: ${reason}.`);
    if (!this.#initialized) {
      this.#started.resolve({ kind: 'failed', reason });
    }
    void this.#process.stop();
  }

  // The Child failed or exited by itself: GrantRelay learns of it through
  // `onStopped` once it has started, or through the failed start.
  #stopItself(reason: string) {
    if (this.#stopping) {
      return;
    }
    const started = this.#initialized;
    this.#halt(reason);
    if (started) {
      this.#events.onStopped(reason, true);
    }
  }

  #failStart(reason: string) {
    this.#halt(reason);
  }

  #fromChild(message: JSONRPCMessage) {
    if (this.#stopping) {
      return;
    }
    if (
      !this.#initialized &&
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id === this.#initializeId
    ) {
      this.#answeredInitialize(message);
      return;
    }
    if (this.#initialized && !this.#handedOver) {
      // It followed the `initialize` answer in the same read.
      void this.#deliverOnceHandedOver(message);
      return;
    }
    this.#events.onMessage(message);
  }

  // The Child's answer to Modgud's `initialize`.
  #answeredInitialize(message: JSONRPCErrorResponse | JSONRPCResultResponse) {
    const result = isJSONRPCResultResponse(message)
      ? parseChildInitializeResult(message.result)
      : undefined;
    if (result === undefined) {
      this.#options.log.warn(
        `${this.#options.label} answered initialize with ${excerpt(JSON.stringify(message), CHILD_LOG_LIMIT)}`,
      );
      this.#failStart(
        isJSONRPCErrorResponse(message) ? 'initialize failed' : 'unsupported initialize result',
      );
      return;
    }
    clearTimeout(this.#initializeTimer);
    this.#initialized = true;
    void this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.#started.resolve({ kind: 'started', result });
    void this.#markHandedOver();
  }

  // GrantRelay handles the start before anything that waits behind the same
  // promise, so this runs after it.
  async #markHandedOver() {
    await this.#started.promise;
    this.#handedOver = true;
  }

  async #deliverOnceHandedOver(message: JSONRPCMessage) {
    await this.#started.promise;
    if (!this.#stopping) {
      this.#events.onMessage(message);
    }
  }
}
