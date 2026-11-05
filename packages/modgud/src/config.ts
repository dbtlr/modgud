import { readFile } from 'node:fs/promises';
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
  idle_timeout_minutes: z.number().positive().default(30),
});

// Phase 1's temporary credential harness: one static bearer token, kept only
// as the SHA-256 hash of the token, in lowercase hex.
const harness = z.strictObject({
  bearer_token_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u, 'Use the SHA-256 hash of the token in lowercase hex.'),
});

const publicListener = z.strictObject({
  // Origins a browser-based Caller may send. A request with any other Origin
  // header is refused; a request without one passes.
  allowed_origins: z.array(z.url()).default([]),
  host: z.string().min(1).default('127.0.0.1'),
  max_sessions: z.int().positive().default(16),
  port: z.int().min(0).max(65_535).default(8470),
});

const configSchema = z.strictObject({
  harness,
  public: publicListener.default(publicListener.parse({})),
  services: z
    .record(z.string().regex(SERVICE_NAME), service)
    .refine((services) => Object.keys(services).length > 0, 'Configure at least one Service.'),
});

export type Config = z.infer<typeof configSchema>;
export type ServiceConfig = Config['services'][string];

// The file `serve` reads when no `--config` names one.
export const defaultConfigPath = (home: string) => join(home, '.config', 'modgud', 'modgud.toml');

// Parses and validates a configuration file's text. Throws an Error that names
// every invalid setting by its path.
export const parseConfig = (text: string): Config => {
  const parsed = configSchema.safeParse(Bun.TOML.parse(text));
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
};

export const readConfig = async (path: string): Promise<Config> =>
  parseConfig(await readFile(path, 'utf8'));
