import { readFile } from 'node:fs/promises';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';

import { z } from 'zod';

// A Service's name is the first segment of its path, as in `/norn/mcp`.
export const SERVICE_NAME = /^[a-z][a-z0-9-]*$/u;

// An environment variable name the Child can receive.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const variableName = z.string().regex(VARIABLE_NAME, 'Use an environment variable name.');

const service = z.strictObject({
  args: z.array(z.string()).default([]),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(variableName, z.string()).default({}),
  // The variable that carries the Grant's Identity. It is reserved: only the
  // Grant sets it, so a value in `env` or the base never reaches the Child.
  identity_env: variableName.optional(),
  // At most one week, which keeps the timer within setTimeout's range.
  idle_timeout_minutes: z.number().positive().max(10_080).default(30),
});

// Phase 1's temporary credential harness: one static bearer token, kept only
// as the SHA-256 hash of the token, in lowercase hex. Its credentials count as
// those of one Grant, and a Grant covers exactly one Service (ADR-0001).
const harness = z.strictObject({
  bearer_token_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u, 'Use the SHA-256 hash of the token in lowercase hex.'),
  // Every OAuth authorization, and every token issued from it, expires this
  // many days after approval, using the value configured when it is checked.
  max_token_lifetime_days: z.int().min(1).max(365).default(30),
  // The one Service the token opens.
  service: z.string(),
});

// A base URL is used as the exact string configured (docs/oauth.md,
// "Addresses"), so it must already be an https origin in canonical form: the
// URL parser's origin lowercases and punycodes the host, drops a default port,
// and drops any userinfo, path, query, or fragment, so any of those shows up
// as a difference.
const baseUrl = z
  .string()
  .refine(
    (url) => URL.canParse(url) && url.startsWith('https://') && new URL(url).origin === url,
    'Use an https URL with a lowercase ASCII host and no default port, path, trailing slash, query, or fragment, such as https://modgud.example.com.',
  );

// The Public listener is reached only through the tunnel (ADR-0003).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const publicListener = z.strictObject({
  // Origins a browser-based Caller may send. A request with any other Origin
  // header is refused; a request without one passes.
  allowed_origins: z.array(z.url()).default([]),
  base_url: baseUrl,
  host: z
    .string()
    .refine(
      (host) => LOOPBACK_HOSTS.has(host),
      'The Public listener binds loopback only: use 127.0.0.1, ::1, or localhost.',
    )
    .default('127.0.0.1'),
  // Retired: Sessions are now limited per Grant. A configuration that still
  // sets it loads, with a warning, and the value is ignored.
  max_sessions: z.unknown().optional(),
  // The Sessions one Grant may hold, counting those still opening. At the
  // limit, a new Session evicts the Grant's least recently active one
  // (ADR-0002).
  max_sessions_per_grant: z.int().positive().default(64),
  port: z.int().min(0).max(65_535).default(8470),
  // How long a Session lasts with no activity. At most one week, which keeps
  // the timer within setTimeout's range.
  session_idle_timeout_minutes: z.number().positive().max(10_080).default(1440),
});

// Tailscale's address ranges. 100.64.0.0/10 is also carrier-grade NAT space
// (docs/oauth.md, "Limitations").
const TAILNET_IPV4 = new BlockList();
TAILNET_IPV4.addSubnet('100.64.0.0', 10, 'ipv4');
const TAILNET_IPV6 = new BlockList();
TAILNET_IPV6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

const isTailnetAddress = (host: string) =>
  (isIPv4(host) && TAILNET_IPV4.check(host, 'ipv4')) ||
  (isIPv6(host) && TAILNET_IPV6.check(host, 'ipv6'));

// The Admin listener binds a tailnet address, or loopback behind a tailnet
// forward such as `tailscale serve`, and sits behind a TLS-terminating proxy
// on the tailnet (ADR-0003, ADR-0004).
const adminListener = z.strictObject({
  base_url: baseUrl,
  host: z
    .string()
    .refine(
      (host) => isTailnetAddress(host) || LOOPBACK_HOSTS.has(host),
      'The Admin listener binds the tailnet or loopback only: use an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48, or 127.0.0.1, ::1, or localhost behind a tailnet forward.',
    ),
  port: z.int().min(0).max(65_535).default(8471),
});

const store = z.strictObject({
  // Absent means `defaultStorePath`.
  path: z
    .string()
    .refine(
      (path) => path.startsWith('/') || path.startsWith('~/'),
      'Use an absolute path or one starting with ~/.',
    )
    .optional(),
});

const configSchema = z
  .strictObject({
    admin: adminListener,
    harness,
    public: publicListener,
    services: z
      .record(z.string().regex(SERVICE_NAME), service)
      .refine((services) => Object.keys(services).length > 0, 'Configure at least one Service.'),
    store: store.default({}),
  })
  .refine((config) => Object.hasOwn(config.services, config.harness.service), {
    message: 'Name a configured Service.',
    path: ['harness', 'service'],
  })
  // Both listeners on loopback must not share a port (ADR-0004). Port 0 asks
  // the system for a free port, so it never collides.
  .refine(
    (config) =>
      !LOOPBACK_HOSTS.has(config.admin.host) ||
      config.admin.port === 0 ||
      config.admin.port !== config.public.port,
    {
      message: 'A loopback Admin listener needs a port other than public.port.',
      path: ['admin', 'port'],
    },
  )
  // Drops the retired settings, with a warning for each one set.
  .transform(({ public: { max_sessions: retired, ...current }, ...config }) => ({
    config: { ...config, public: current },
    warnings:
      retired === undefined
        ? []
        : [
            `public.max_sessions is ignored: Modgud now limits the Sessions of each Grant with public.max_sessions_per_grant, which is ${String(current.max_sessions_per_grant)}.`,
          ],
  }));

export type Config = z.output<typeof configSchema>['config'];
export type ServiceConfig = Config['services'][string];

// The file `serve` reads when no `--config` names one.
export const defaultConfigPath = (home: string) => join(home, '.config', 'modgud', 'modgud.toml');

// A Service's OAuth resource URI.
export const serviceResource = (config: Config, serviceName: string) =>
  `${config.public.base_url}/${serviceName}/mcp`;

// The OAuth store's database file: `store.path` with a leading `~/` expanded
// to home, or `~/.local/state/modgud/modgud.sqlite` when it is absent.
export const resolveStorePath = (config: Config, home: string) => {
  const path = config.store.path ?? '~/.local/state/modgud/modgud.sqlite';
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
};

// Parses and validates a configuration file's text, with a warning for each
// retired setting it still sets. Throws an Error that names every invalid
// setting by its path.
export const parseConfigWithWarnings = (text: string): { config: Config; warnings: string[] } => {
  const parsed = configSchema.safeParse(Bun.TOML.parse(text));
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
};

export const parseConfig = (text: string): Config => parseConfigWithWarnings(text).config;

export const readConfig = async (path: string): Promise<{ config: Config; warnings: string[] }> =>
  parseConfigWithWarnings(await readFile(path, 'utf8'));
