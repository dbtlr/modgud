import { expect, test } from 'bun:test';

import { LoggingError } from '@loomcli/plugins/logging';

import { reportLogFailures } from './log.ts';

test('a log that cannot be written is reported once per failure, naming the step and path', () => {
  const printed: string[] = [];
  const report = reportLogFailures((line) => printed.push(line));
  const denied = new LoggingError('append', {
    cause: new Error('EACCES: permission denied'),
    path: '/home/me/.local/state/modgud/modgud.jsonl',
  });

  report(denied);
  report(denied);
  report(new LoggingError('unresolved-directory', { path: null, variable: 'HOME' }));

  expect(printed).toEqual([
    'Modgud cannot write its log (append) at /home/me/.local/state/modgud/modgud.jsonl: EACCES: permission denied',
    'Modgud cannot write its log: HOME is not set.',
  ]);
});
