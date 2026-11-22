import { describe, expect, test } from 'bun:test';

import { LoggingError } from '@loomcli/plugins/logging';

import { CHILD_LOG_LIMIT, excerptOfMessage, reportLogFailures } from './log.ts';
import { nestedJson } from './testing/nested-json.ts';

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

describe('excerptOfMessage', () => {
  test('gives a message as JSON, cut to the Child log limit', () => {
    expect(excerptOfMessage({ jsonrpc: '2.0', method: 'notifications/odd' })).toBe(
      '{"jsonrpc":"2.0","method":"notifications/odd"}',
    );
    expect(excerptOfMessage({ text: 'x'.repeat(CHILD_LOG_LIMIT + 1) })).toHaveLength(
      CHILD_LOG_LIMIT,
    );
  });

  test('names a message nested too deeply to stringify instead of throwing', () => {
    const deep: unknown = JSON.parse(nestedJson(100_000));

    expect(excerptOfMessage({ params: deep })).toBe('(nested too deeply to log)');
  });
});
