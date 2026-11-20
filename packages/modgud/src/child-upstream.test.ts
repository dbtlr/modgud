import { afterEach, test } from 'bun:test';

import { createChildUpstream } from './child-upstream.ts';
import { waitFor } from './testing/listener-harness.ts';

const leftover: number[] = [];

// Whether a process with this pid exists.
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const pid of leftover.splice(0)) {
    if (isRunning(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
});

test('stopped waits until the process a wrapped Child started is gone', async () => {
  const lines: string[] = [];
  // The wrapper dies on SIGTERM; the process it started reports its pid on
  // stderr, ignores SIGTERM, and never reads stdin.
  const upstream = createChildUpstream({
    command: {
      args: ['-c', `sh -c 'trap "" TERM; echo $$ >&2; exec sleep 60' & wait`],
      command: '/bin/sh',
    },
    environment: () => ({ PATH: process.env.PATH ?? '' }),
    label: 'wrapped',
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    startTimeoutMs: 10_000,
  })(
    { onMessage: () => undefined, onRequestFailed: () => undefined, onStopped: () => undefined },
    () => 1,
  );
  void upstream.start();
  const prefix = 'wrapped stderr: ';
  await waitFor(() => lines.some((line) => line.startsWith(prefix)));
  const pid = Number(lines.find((line) => line.startsWith(prefix))?.slice(prefix.length));
  leftover.push(pid);

  upstream.stop('shutdown');
  await upstream.stopped;
  // Only the init process's reaping is left to wait for.
  await waitFor(() => !isRunning(pid), 500);
}, 10_000);
