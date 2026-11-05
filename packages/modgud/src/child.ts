import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

// How long a Child gets to exit after SIGTERM before it is killed.
const STOP_GRACE_MS = 2000;

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
  // Called once, when the process has exited for any reason.
  onExit: () => void;
};

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

  // Starts the process. Throws when it cannot be started, for example when
  // the command or working directory does not exist.
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

  async #watchExit(process: Bun.Subprocess) {
    await process.exited;
    this.#options.onExit();
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

  async #readStderr(stderr: ReadableStream<Uint8Array>) {
    let pending = '';
    for await (const text of stderr.pipeThrough(new TextDecoderStream())) {
      const lines = `${pending}${text}`.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        this.#options.onStderr(line);
      }
    }
    if (pending !== '') {
      this.#options.onStderr(pending);
    }
  }

  // Writes one message to the process's stdin. Throws when it is not running.
  send(message: JSONRPCMessage) {
    const stdin = this.#process?.stdin;
    if (stdin === undefined) {
      throw new Error('The Child is not running.');
    }
    void stdin.write(serializeMessage(message));
    void stdin.flush();
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
