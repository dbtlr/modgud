import { describe, expect, test } from 'bun:test';

import { parseConfig } from './config.ts';

const HASH = 'a'.repeat(64);

describe('parseConfig', () => {
  test('fills the public listener and Service defaults', () => {
    const config = parseConfig(`
      [harness]
      bearer_token_sha256 = "${HASH}"
      service = "norn"

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
        service = "norn"

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
        service = "norn"

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
        service = "norn"

        [services]
      `),
    ).toThrow(/at least one Service/u);
  });

  test('refuses an unknown setting, so a typo does not pass silently', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"
        service = "norn"

        [services.norn]
        command = "norn"
        idle_timeout = 5
      `),
    ).toThrow(/idle_timeout/u);
  });

  test('refuses a harness Service that is not configured, naming the setting', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"
        service = "mimir"

        [services.norn]
        command = "norn"
      `),
    ).toThrow(/harness\.service/u);
  });

  test('refuses a Public listener host that is not loopback, naming the rule', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"
        service = "norn"

        [public]
        host = "0.0.0.0"

        [services.norn]
        command = "norn"
      `),
    ).toThrow(/loopback only[\s\S]*public\.host/u);
  });

  test('accepts each loopback host for the Public listener', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const config = parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"
        service = "norn"

        [public]
        host = "${host}"

        [services.norn]
        command = "norn"
      `);
      expect(config.public.host).toBe(host);
    }
  });

  test('refuses an idle timeout longer than one week', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"
        service = "norn"

        [services.norn]
        command = "norn"
        idle_timeout_minutes = 10081
      `),
    ).toThrow(/idle_timeout_minutes/u);
  });
});
