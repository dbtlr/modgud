import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

// How long a Child gets to exit after SIGTERM before it is killed.
const STOP_GRACE_MS = 2000;

// The most code points of one stderr line Modgud holds (ADR-0002). A longer
// line is reported once it reaches this length, and the rest of it dropped.
export const STDERR_LINE_LIMIT = 4096;

// The first `limit` code points of `text`, and how many that is. It reads no
// further than it needs.
const leadingCodePoints = (text: string, limit: number) => {
  let count = 0;
  let end = 0;
  for (const character of text) {
    if (count === limit) {
      break;
    }
    count += 1;
    end += character.length;
  }
  return { count, head: text.slice(0, end) };
};

export type ChildOptions = {
  args: string[];
  command: string;
  cwd: string | undefined;
  environment: Record<string, string>;
  // Each message the process writes to stdout.
  onMessage: (message: JSONRPCMessage) => void;
  // A stdout line that is JSON but not a JSON-RPC message. The SDK's
  // ReadBuffer skips a line that is not JSON at all without reporting it.
  onUnreadable: (error: Error) => void;
  // Stdout can no longer be read as messages, as when one message is larger
  // than the read buffer allows. Modgud reads no more of it.
  onFatal: (error: Error) => void;
  // Each line the process writes to stderr.
  onStderr: (line: string) => void;
  // Called once, when the process has exited for any reason, with its exit
  // code or the signal that ended it.
  onExit: (status: ExitStatus) => void;
};

export type ExitStatus = { code: number | null; signal: string | null };

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

// A Service process that speaks MCP over stdio. Unlike the SDK's stdio client
// transport, which always adds variables from Modgud's own environment, it
// starts the process with exactly the environment it is given (ADR-0002).
export class Child {
  readonly #options: ChildOptions;
  #process: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;

  constructor(options: ChildOptions) {
    this.#options = options;
  }

  // Starts the process. Immediate spawn errors throw; failures after the
  // runtime creates a process are reported through onExit.
  start() {
    const { args, command, cwd, environment } = this.#options;
    const process = Bun.spawn([command, ...args], {
      ...(cwd === undefined ? {} : { cwd }),
      env: environment,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    });
    this.#process = process;
    void this.#readMessages(process.stdout);
    void this.#readStderr(process.stderr);
    void this.#watchExit(process);
  }

  // The process id, once started.
  get pid() {
    return this.#process?.pid;
  }

  async #watchExit(process: Bun.Subprocess) {
    await process.exited;
    this.#options.onExit({
      code: process.exitCode,
      signal: process.signalCode === null ? null : String(process.signalCode),
    });
  }

  async #readMessages(stdout: ReadableStream<Uint8Array>) {
    const buffer = new ReadBuffer();
    for await (const chunk of stdout) {
      try {
        buffer.append(Buffer.from(chunk));
      } catch (error) {
        this.#options.onFatal(asError(error));
        return;
      }
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = buffer.readMessage();
        } catch (error) {
          this.#options.onUnreadable(asError(error));
          continue;
        }
        if (message === null) {
          break;
        }
        this.#options.onMessage(message);
      }
    }
  }

  // Reports each stderr line, holding at most STDERR_LINE_LIMIT code points of
  // the line in progress. Each chunk is split on its own, so a long line costs
  // time linear in its length.
  async #readStderr(stderr: ReadableStream<Uint8Array>) {
    let pending = '';
    let pendingCount = 0;
    // Set once the line in progress was reported at the limit, until its newline.
    let dropping = false;
    for await (const text of stderr.pipeThrough(new TextDecoderStream())) {
      const parts = text.split('\n');
      for (const [index, part] of parts.entries()) {
        if (!dropping && part !== '') {
          const { count, head } = leadingCodePoints(part, STDERR_LINE_LIMIT - pendingCount);
          pending += head;
          pendingCount += count;
          if (pendingCount === STDERR_LINE_LIMIT) {
            this.#options.onStderr(pending);
            pending = '';
            pendingCount = 0;
            dropping = true;
          }
        }
        if (index < parts.length - 1) {
          if (!dropping) {
            this.#options.onStderr(pending);
          }
          pending = '';
          pendingCount = 0;
          dropping = false;
        }
      }
    }
    if (!dropping && pending !== '') {
      this.#options.onStderr(pending);
    }
  }

  // Writes one message to the process's stdin. Rejects when it is not
  // running or the write fails.
  async send(message: JSONRPCMessage) {
    const stdin = this.#process?.stdin;
    if (stdin === undefined) {
      throw new Error('The Child is not running.');
    }
    await stdin.write(serializeMessage(message));
    await stdin.flush();
  }

  // Stops the process: SIGTERM, then SIGKILL if it has not exited in time.
  async stop() {
    const process = this.#process;
    if (process === undefined || process.exitCode !== null || process.signalCode !== null) {
      return;
    }
    process.kill('SIGTERM');
    const timer = setTimeout(() => process.kill('SIGKILL'), STOP_GRACE_MS);
    await process.exited;
    clearTimeout(timer);
  }
}
