import { describe, expect, test } from 'bun:test';

import { parseConfig } from './config.ts';

const HASH = 'a'.repeat(64);

describe('parseConfig', () => {
  test('fills the public listener and Service defaults', () => {
    const config = parseConfig(`
      [harness]
      bearer_token_sha256 = "${HASH}"

      [services.norn]
      command = "norn"
    `);

    expect(config.public).toEqual({
      allowed_origins: [],
      host: '127.0.0.1',
      max_sessions: 16,
      port: 8470,
    });
    expect(config.services.norn).toEqual({
      args: [],
      command: 'norn',
      env: {},
      idle_timeout_minutes: 30,
    });
  });

  test('refuses a token that is not a SHA-256 hash, naming the setting', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "plain-secret"

        [services.norn]
        command = "norn"
      `),
    ).toThrow(/harness\.bearer_token_sha256/u);
  });

  test('refuses a Service name that cannot be a path segment', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"

        [services."../admin"]
        command = "norn"
      `),
    ).toThrow(/services\["\.\.\/admin"\]/u);
  });

  test('refuses a configuration without Services', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"

        [services]
      `),
    ).toThrow(/at least one Service/u);
  });

  test('refuses an unknown setting, so a typo does not pass silently', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"

        [services.norn]
        command = "norn"
        idle_timeout = 5
      `),
    ).toThrow(/idle_timeout/u);
  });
});
