import { expect, test } from 'bun:test';

import { Child } from './child.ts';
import { waitFor } from './testing/listener-harness.ts';

// Starts a Bun script as a Child and collects the stderr lines it reports.
const runScript = (script: string) => {
  const lines: string[] = [];
  const exited = Promise.withResolvers<void>();
  const child = new Child({
    args: ['-e', script],
    command: process.execPath,
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

test('a stderr line past 4096 code points is reported at once, cut, and its rest dropped', async () => {
  // Half the line, a pause, the rest of it, then a short line.
  const { exited, lines } = runScript(`
    process.stderr.write('y'.repeat(10000));
    await Bun.sleep(1000);
    process.stderr.write('y'.repeat(10000) + '\\nnext\\n');
  `);
  await waitFor(() => lines.length > 0);
  expect(lines).toEqual(['y'.repeat(4096)]);
  await exited;
  await waitFor(() => lines.length > 1);
  expect(lines).toEqual(['y'.repeat(4096), 'next']);
});

test('the stderr cap counts code points, not UTF-16 code units', async () => {
  const { exited, lines } = runScript(`process.stderr.write('😀'.repeat(5000) + '\\n');`);
  await exited;
  await waitFor(() => lines.length > 0);
  expect(lines).toEqual(['😀'.repeat(4096)]);
});

test('a stderr line with no newline at exit is still reported', async () => {
  const { exited, lines } = runScript(`process.stderr.write('first\\nlast');`);
  await exited;
  await waitFor(() => lines.length > 1);
  expect(lines).toEqual(['first', 'last']);
});
