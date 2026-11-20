import { afterEach, expect, test } from 'bun:test';

import { Child } from './child.ts';
import { waitFor } from './testing/listener-harness.ts';

// Starts a command as a Child and collects the stderr lines it reports.
const run = (command: string, args: string[]) => {
  const lines: string[] = [];
  const exited = Promise.withResolvers<void>();
  const child = new Child({
    args,
    command,
    cwd: undefined,
    environment: { PATH: process.env.PATH ?? '' },
    onExit: () => exited.resolve(),
    onFatal: () => undefined,
    onMessage: () => undefined,
    onStderr: (line) => lines.push(line),
    onUnreadable: () => undefined,
  });
  child.start();
  return { child, exited: exited.promise, lines };
};

// Starts a Bun script as a Child.
const runScript = (script: string) => run(process.execPath, ['-e', script]);

// A process the wrapper starts in the background. It reports its pid on
// stderr, then ignores SIGTERM and never reads stdin, so neither a signal to
// the wrapper nor stdin EOF stops it.
const STUBBORN = `sh -c 'trap "" TERM; echo $$ >&2; exec sleep 60' &`;

const stubbornPids: number[] = [];

// Whether a process with this pid exists.
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Starts a wrapper script as a Child and waits for its stubborn process's pid.
const runWrapper = async (script: string) => {
  const started = run('/bin/sh', ['-c', script]);
  await waitFor(() => started.lines.length > 0);
  const pid = Number(started.lines[0]);
  stubbornPids.push(pid);
  return { ...started, pid };
};

afterEach(() => {
  for (const pid of stubbornPids.splice(0)) {
    if (isRunning(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
});

test('stopping a wrapped Child stops the process it started that ignores SIGTERM and stdin EOF', async () => {
  const { child, pid } = await runWrapper(`${STUBBORN} wait`);
  expect(isRunning(pid)).toBe(true);
  await child.stop();
  await waitFor(() => !isRunning(pid), 1000);
}, 10_000);

test('stopping a Child whose wrapper already exited stops the process it left behind', async () => {
  const { child, exited, pid } = await runWrapper(STUBBORN);
  await exited;
  expect(isRunning(pid)).toBe(true);
  await child.stop();
  await waitFor(() => !isRunning(pid), 1000);
}, 10_000);

test('a stderr line past 2000 code points is reported at once, cut, and its rest dropped', async () => {
  // Half the line, a pause, the rest of it, then a short line.
  const { exited, lines } = runScript(`
    process.stderr.write('y'.repeat(10000));
    await Bun.sleep(1000);
    process.stderr.write('y'.repeat(10000) + '\\nnext\\n');
  `);
  await waitFor(() => lines.length > 0);
  expect(lines).toEqual(['y'.repeat(2000)]);
  await exited;
  await waitFor(() => lines.length > 1);
  expect(lines).toEqual(['y'.repeat(2000), 'next']);
});

test('the stderr cap counts code points, not UTF-16 code units', async () => {
  const { exited, lines } = runScript(`process.stderr.write('😀'.repeat(3000) + '\\n');`);
  await exited;
  await waitFor(() => lines.length > 0);
  expect(lines).toEqual(['😀'.repeat(2000)]);
});

test('a stderr line with no newline at exit is still reported', async () => {
  const { exited, lines } = runScript(`process.stderr.write('first\\nlast');`);
  await exited;
  await waitFor(() => lines.length > 1);
  expect(lines).toEqual(['first', 'last']);
});

test('stopping a Child that exits on SIGTERM does not wait out the grace period', async () => {
  const { child } = runScript('await Bun.sleep(60_000);');
  await Bun.sleep(100);
  const begun = Date.now();
  await child.stop();
  expect(Date.now() - begun).toBeLessThan(1000);
});
