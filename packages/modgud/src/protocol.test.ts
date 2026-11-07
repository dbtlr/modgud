import { describe, expect, test } from 'bun:test';

import {
  callerCapabilities,
  initializeAnswer,
  negotiatedVersion,
  parseChildInitializeResult,
  stillMatches,
} from './protocol.ts';

const childResult = {
  capabilities: { tools: { listChanged: true } },
  protocolVersion: '2025-11-25',
  serverInfo: { name: 'child', version: '1' },
};

describe('negotiatedVersion', () => {
  test("gives the Caller's version when Modgud supports it and it is no newer than the Child's", () => {
    expect(negotiatedVersion('2025-06-18', '2025-11-25')).toBe('2025-06-18');
    expect(negotiatedVersion('2025-11-25', '2025-11-25')).toBe('2025-11-25');
  });

  test("gives the Child's version when the Caller's is newer or unsupported", () => {
    expect(negotiatedVersion('2025-11-25', '2025-06-18')).toBe('2025-06-18');
    expect(negotiatedVersion('2026-07-28', '2025-11-25')).toBe('2025-11-25');
    expect(negotiatedVersion('2024-11-05', '2025-11-25')).toBe('2025-11-25');
  });
});

describe('callerCapabilities', () => {
  test('removes tasks and resource subscriptions, and keeps everything else', () => {
    expect(
      callerCapabilities({
        logging: {},
        resources: { listChanged: true, subscribe: true },
        tasks: { list: {} },
        tools: { listChanged: true },
      }),
    ).toEqual({ logging: {}, resources: { listChanged: true }, tools: { listChanged: true } });
  });
});

describe('parseChildInitializeResult', () => {
  test('accepts a 2025-era result', () => {
    expect(parseChildInitializeResult(childResult)).toEqual(childResult);
  });

  test('refuses a version that is not a 2025-era version Modgud supports, or a malformed result', () => {
    expect(parseChildInitializeResult({ ...childResult, protocolVersion: '2024-11-05' })).toBe(
      undefined,
    );
    expect(parseChildInitializeResult({ ...childResult, protocolVersion: '2026-07-28' })).toBe(
      undefined,
    );
    expect(parseChildInitializeResult({ protocolVersion: '2025-11-25' })).toBe(undefined);
  });
});

describe('initializeAnswer and stillMatches', () => {
  test("answers from the Child's result and records what the Session was given", () => {
    const answer = initializeAnswer('2025-06-18', {
      ...childResult,
      capabilities: { resources: { subscribe: true }, tasks: {} },
      instructions: 'Use it well.',
    });

    expect(answer.result).toEqual({
      capabilities: { resources: {} },
      instructions: 'Use it well.',
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'child', version: '1' },
    });
  });

  test('a Session still matches a Child with the same capabilities and a version no older than its own', () => {
    const { given } = initializeAnswer('2025-06-18', childResult);

    expect(stillMatches(given, childResult)).toBe(true);
    expect(stillMatches(given, { ...childResult, protocolVersion: '2025-06-18' })).toBe(true);
    expect(stillMatches(given, { ...childResult, protocolVersion: '2025-03-26' })).toBe(false);
    expect(stillMatches(given, { ...childResult, capabilities: { tools: {} } })).toBe(false);
  });

  test('capability order does not matter, and hidden capabilities do not count', () => {
    const { given } = initializeAnswer('2025-11-25', {
      ...childResult,
      capabilities: { prompts: {}, tools: { listChanged: true } },
    });

    expect(
      stillMatches(given, {
        ...childResult,
        capabilities: { prompts: {}, tasks: {}, tools: { listChanged: true } },
      }),
    ).toBe(true);
  });
});
