import { describe, expect, test } from 'bun:test';

import { parseConfig, parseConfigWithWarnings, resolveStorePath } from './config.ts';

const HASH = 'a'.repeat(64);

// The sections every configuration needs besides its Services, with one
// setting replaced or added through `overrides` as `section.key = value` TOML.
const configWith = (overrides: Record<string, string> = {}) => {
  const settings: Record<string, Record<string, string>> = {
    admin: { base_url: '"https://modgud.example.ts.net"', host: '"100.64.0.1"' },
    harness: { bearer_token_sha256: `"${HASH}"`, service: '"norn"' },
    public: { base_url: '"https://modgud.example.com"' },
    'services.norn': { command: '"norn"' },
  };
  for (const [path, value] of Object.entries(overrides)) {
    const dot = path.lastIndexOf('.');
    const section = path.slice(0, dot);
    settings[section] = { ...settings[section], [path.slice(dot + 1)]: value };
  }
  return Object.entries(settings)
    .map(
      ([section, values]) =>
        `[${section}]\n${Object.entries(values)
          .map(([key, value]) => `${key} = ${value}`)
          .join('\n')}`,
    )
    .join('\n\n');
};

describe('parseConfig', () => {
  test('fills the public listener and Service defaults', () => {
    const config = parseConfig(`
      [harness]
      bearer_token_sha256 = "${HASH}"
      service = "norn"

      [public]
      base_url = "https://modgud.example.com"

      [admin]
      base_url = "https://modgud.example.ts.net"
      host = "100.64.0.1"

      [services.norn]
      command = "norn"
    `);

    expect(config.harness.max_token_lifetime_days).toBe(30);
    expect(config.admin).toEqual({
      base_url: 'https://modgud.example.ts.net',
      host: '100.64.0.1',
      port: 8471,
    });
    expect(config.public).toEqual({
      allowed_origins: [],
      base_url: 'https://modgud.example.com',
      host: '127.0.0.1',
      max_sessions_per_grant: 64,
      port: 8470,
      session_idle_timeout_minutes: 1440,
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
      parseConfig(configWith({ 'harness.bearer_token_sha256': '"plain-secret"' })),
    ).toThrow(/harness\.bearer_token_sha256/u);
  });

  test('refuses a Service name that cannot be a path segment', () => {
    expect(() => parseConfig(configWith({ 'services."../admin".command': '"norn"' }))).toThrow(
      /services\["\.\.\/admin"\]/u,
    );
  });

  test('refuses a configuration without Services', () => {
    expect(() =>
      parseConfig(`
        [harness]
        bearer_token_sha256 = "${HASH}"
        service = "norn"

        [public]
        base_url = "https://modgud.example.com"

        [admin]
        base_url = "https://modgud.example.ts.net"
        host = "100.64.0.1"

        [services]
      `),
    ).toThrow(/at least one Service/u);
  });

  test('refuses an unknown setting, so a typo does not pass silently', () => {
    expect(() => parseConfig(configWith({ 'services.norn.idle_timeout': '5' }))).toThrow(
      /idle_timeout/u,
    );
  });

  test('refuses a harness Service that is not configured, naming the setting', () => {
    expect(() => parseConfig(configWith({ 'harness.service': '"mimir"' }))).toThrow(
      /harness\.service/u,
    );
  });

  test('refuses a Public listener host that is not loopback, naming the rule', () => {
    expect(() => parseConfig(configWith({ 'public.host': '"0.0.0.0"' }))).toThrow(
      /loopback only[\s\S]*public\.host/u,
    );
  });

  test('accepts each loopback host for the Public listener', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      const config = parseConfig(configWith({ 'public.host': `"${host}"` }));
      expect(config.public.host).toBe(host);
    }
  });

  test('refuses an idle timeout longer than one week', () => {
    expect(() =>
      parseConfig(configWith({ 'services.norn.idle_timeout_minutes': '10081' })),
    ).toThrow(/idle_timeout_minutes/u);
  });

  test('refuses a Session idle timeout longer than one week, naming the setting', () => {
    expect(() =>
      parseConfig(configWith({ 'public.session_idle_timeout_minutes': '10081' })),
    ).toThrow(/public\.session_idle_timeout_minutes/u);
    expect(
      parseConfig(configWith({ 'public.session_idle_timeout_minutes': '10080' })).public
        .session_idle_timeout_minutes,
    ).toBe(10_080);
  });

  test('refuses a Session limit per Grant below 1, naming the setting', () => {
    expect(() => parseConfig(configWith({ 'public.max_sessions_per_grant': '0' }))).toThrow(
      /public\.max_sessions_per_grant/u,
    );
  });

  test('accepts the retired public.max_sessions, ignores it, and warns that it is replaced', () => {
    const { config, warnings } = parseConfigWithWarnings(
      configWith({ 'public.max_sessions': '16' }),
    );

    expect(config.public).not.toHaveProperty('max_sessions');
    expect(config.public.max_sessions_per_grant).toBe(64);
    expect(warnings).toEqual([
      'public.max_sessions is ignored: Modgud now limits the Sessions of each Grant with public.max_sessions_per_grant, which is 64.',
    ]);
  });

  test('has no warnings for a current configuration', () => {
    expect(parseConfigWithWarnings(configWith()).warnings).toEqual([]);
  });

  test('accepts a token lifetime from 1 to 365 days', () => {
    for (const days of [1, 365]) {
      const config = parseConfig(configWith({ 'harness.max_token_lifetime_days': String(days) }));
      expect(config.harness.max_token_lifetime_days).toBe(days);
    }
  });

  test('refuses a token lifetime outside 1 to 365 whole days, naming the setting', () => {
    for (const days of ['0', '366', '1.5']) {
      expect(() => parseConfig(configWith({ 'harness.max_token_lifetime_days': days }))).toThrow(
        /harness\.max_token_lifetime_days/u,
      );
    }
  });

  test('requires the Public and Admin listeners their base URLs', () => {
    const withoutPublic = configWith().replace('base_url = "https://modgud.example.com"', '');
    expect(() => parseConfig(withoutPublic)).toThrow(/public\.base_url/u);
    const withoutAdmin = configWith().replace('base_url = "https://modgud.example.ts.net"', '');
    expect(() => parseConfig(withoutAdmin)).toThrow(/admin\.base_url/u);
  });

  test('accepts a base URL with a lowercase ASCII host and an explicit other port', () => {
    for (const url of [
      'https://modgud.example.com',
      'https://modgud.example.com:8443',
      'https://xn--e1afmkfd.xn--p1ai',
    ]) {
      const config = parseConfig(
        configWith({ 'admin.base_url': `"${url}"`, 'public.base_url': `"${url}"` }),
      );
      expect(config.public.base_url).toBe(url);
      expect(config.admin.base_url).toBe(url);
    }
  });

  test('refuses a base URL that is not exactly an https origin, naming the setting', () => {
    for (const url of [
      'http://modgud.example.com',
      'https://Modgud.example.com',
      'https://пример.рф',
      'https://modgud.example.com:443',
      'https://modgud.example.com/',
      'https://modgud.example.com/oauth',
      'https://modgud.example.com?x=1',
      'https://modgud.example.com#top',
      'https://user@modgud.example.com',
      'modgud.example.com',
    ]) {
      expect(() => parseConfig(configWith({ 'public.base_url': `"${url}"` }))).toThrow(
        /public\.base_url/u,
      );
      expect(() => parseConfig(configWith({ 'admin.base_url': `"${url}"` }))).toThrow(
        /admin\.base_url/u,
      );
    }
  });

  test('accepts an Admin listener host on the tailnet', () => {
    for (const host of [
      '100.64.0.1',
      '100.127.255.254',
      'fd7a:115c:a1e0::1',
      'fd7a:115c:a1e0:ab12::9',
    ]) {
      expect(parseConfig(configWith({ 'admin.host': `"${host}"` })).admin.host).toBe(host);
    }
  });

  test('accepts a loopback Admin listener host, for a tailnet forward in front of it', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(parseConfig(configWith({ 'admin.host': `"${host}"` })).admin.host).toBe(host);
    }
  });

  test('refuses a loopback Admin listener on the Public listener port, naming the setting', () => {
    expect(() =>
      parseConfig(configWith({ 'admin.host': '"127.0.0.1"', 'admin.port': '8470' })),
    ).toThrow(/admin\.port/u);
    expect(
      parseConfig(configWith({ 'admin.host': '"127.0.0.1"', 'admin.port': '8471' })).admin.port,
    ).toBe(8471);
  });

  test('refuses an Admin listener host neither on the tailnet nor loopback, naming the setting', () => {
    for (const host of [
      '100.63.255.255',
      '100.128.0.1',
      '127.0.0.2',
      '0.0.0.0',
      '::',
      '::ffff:100.64.0.1',
      '::ffff:127.0.0.1',
      'fd7a:115c:a1e1::1',
      'modgud.example.ts.net',
    ]) {
      expect(() => parseConfig(configWith({ 'admin.host': `"${host}"` }))).toThrow(/admin\.host/u);
    }
  });

  test('requires the Admin listener host', () => {
    const withoutHost = configWith().replace('host = "100.64.0.1"', '');
    expect(() => parseConfig(withoutHost)).toThrow(/admin\.host/u);
  });

  test('refuses an Admin listener port outside 0 to 65535', () => {
    expect(() => parseConfig(configWith({ 'admin.port': '65536' }))).toThrow(/admin\.port/u);
    expect(parseConfig(configWith({ 'admin.port': '9000' })).admin.port).toBe(9000);
  });

  test('refuses a store path that is neither absolute nor under ~/, naming the setting', () => {
    for (const path of ['', 'modgud.sqlite', '~other/modgud.sqlite']) {
      expect(() => parseConfig(configWith({ 'store.path': `"${path}"` }))).toThrow(/store\.path/u);
    }
  });
});

describe('resolveStorePath', () => {
  test('defaults to the state directory under home', () => {
    expect(resolveStorePath(parseConfig(configWith()), '/home/someone')).toBe(
      '/home/someone/.local/state/modgud/modgud.sqlite',
    );
  });

  test('expands a leading ~/ to home', () => {
    const config = parseConfig(configWith({ 'store.path': '"~/state/modgud.db"' }));
    expect(resolveStorePath(config, '/home/someone')).toBe('/home/someone/state/modgud.db');
  });

  test('keeps an absolute path', () => {
    const config = parseConfig(configWith({ 'store.path': '"/var/lib/modgud/modgud.db"' }));
    expect(resolveStorePath(config, '/home/someone')).toBe('/var/lib/modgud/modgud.db');
  });
});
