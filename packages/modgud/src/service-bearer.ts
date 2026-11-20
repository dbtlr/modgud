import { readFile } from 'node:fs/promises';

import { expandHome } from './config.ts';
import type { HttpServiceConfig } from './config.ts';

// Why an HTTP Service's bearer could not be read. A failure carries only its
// category, never the file's contents or the TOML parser's message, which can
// quote them (ADR-0005).
export type BearerFailure =
  | 'missing'
  | 'unreadable'
  | 'not TOML'
  | 'no string at path'
  | 'invalid secret';

export type BearerRead =
  | { kind: 'read'; secret: string }
  | { kind: 'failed'; failure: BearerFailure };

// A secret is non-empty and holds only visible ASCII characters.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The string at a dotted path of keys in a parsed TOML document, or undefined
// when the path names no string. Each step checks the key as the table's own,
// so a key such as `__proto__` or `toString` never reaches inherited values.
const stringAt = (document: unknown, path: string): string | undefined => {
  let value = document;
  for (const key of path.split('.')) {
    if (!isTable(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return typeof value === 'string' ? value : undefined;
};

const failed = (failure: BearerFailure): BearerRead => ({ failure, kind: 'failed' });

// Reads an HTTP Service's bearer, as a Link does when it starts. Without
// `bearer_key`, the secret is the file's contents without surrounding
// whitespace; with it, the string at that dotted path of the file parsed as
// TOML, used as it is.
export const readServiceBearer = async (
  service: Pick<HttpServiceConfig, 'bearer_file' | 'bearer_key'>,
  home: string,
): Promise<BearerRead> => {
  let text: string;
  try {
    text = await readFile(expandHome(service.bearer_file, home), 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return failed(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }
  let secret: string | undefined;
  if (service.bearer_key === undefined) {
    secret = text.trim();
  } else {
    let document: unknown;
    try {
      document = Bun.TOML.parse(text);
    } catch {
      return failed('not TOML');
    }
    secret = stringAt(document, service.bearer_key);
    if (secret === undefined) {
      return failed('no string at path');
    }
  }
  return VISIBLE_ASCII.test(secret) ? { kind: 'read', secret } : failed('invalid secret');
};
