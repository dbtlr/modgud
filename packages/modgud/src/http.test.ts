import { expect, test } from 'bun:test';

import { answerUnexpectedError } from './http.ts';
import { createLogRecorder } from './testing/log-recorder.ts';

test('an HTTP 500 log contains the encoded path and escaped error', () => {
  const { entries, log } = createLogRecorder();
  const request = new Request('https://example.test/a\u001b\u0000\u0085\n/b?token=secret');

  const response = answerUnexpectedError(log, request, new Error('disk\n\u001b[31m'));

  expect(response.status).toBe(500);
  expect(entries).toEqual([
    {
      fields: { error: String.raw`disk\u000a\u001b[31m`, method: 'GET', path: '/a%1B%00%C2%85/b' },
      level: 'warn',
      message: 'Answered {method} {path} with HTTP 500: {error}',
    },
  ]);
});
