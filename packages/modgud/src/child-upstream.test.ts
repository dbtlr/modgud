import { afterEach, expect, test } from 'bun:test';

import { createChildUpstream } from './child-upstream.ts';
import { waitFor } from './testing/listener-harness.ts';
import { createLogRecorder } from './testing/log-recorder.ts';

const STDERR = '{service} {upstream} for {grant} stderr: {line}';

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
  const { entries, log } = createLogRecorder();
  // The wrapper dies on SIGTERM; the process it started reports its pid on
  // stderr, ignores SIGTERM, and never reads stdin.
  const upstream = createChildUpstream({
    command: {
      args: ['-c', `sh -c 'trap "" TERM; echo $$ >&2; exec sleep 60' & wait`],
      command: '/bin/sh',
    },
    environment: () => ({ PATH: process.env.PATH ?? '' }),
    log: log.with({ grant: 'g', service: 'wrapped', upstream: 'child' }),
    startTimeoutMs: 10_000,
  })(
    { onMessage: () => undefined, onRequestFailed: () => undefined, onStopped: () => undefined },
    () => 1,
  );
  void upstream.start();
  const stderr = () => entries.filter((entry) => entry.message === STDERR);
  await waitFor(() => stderr().length > 0);
  const [first] = stderr();
  // The Child's events carry the fields its Grant's log was bound with.
  expect(first?.fields).toMatchObject({ grant: 'g', service: 'wrapped', upstream: 'child' });
  const pid = Number(first?.fields.line);
  leftover.push(pid);

  upstream.stop('shutdown');
  await upstream.stopped;
  expect(isRunning(pid)).toBe(false);
}, 10_000);
