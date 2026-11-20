import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

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

// The largest bearer file Modgud reads. A token file holds a few secrets, so
// this bounds the read of a file that is far larger than one.
export const MAX_BEARER_FILE_BYTES = 64 * 1024;

const errorCode = (error: unknown) =>
  error instanceof Error && 'code' in error ? error.code : undefined;

// The text of a regular file of at most MAX_BEARER_FILE_BYTES, or why it
// cannot be read. It opens without blocking, so a FIFO without a writer fails
// at once, and checks the opened file itself, so a FIFO or a device such as
// /dev/zero is refused instead of read forever.
const readBearerFile = async (
  path: string,
): Promise<{ text: string } | { failure: 'missing' | 'unreadable' }> => {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    return { failure: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_BEARER_FILE_BYTES) {
      return { failure: 'unreadable' };
    }
    // One byte past the limit shows a file that grew after the check.
    const buffer = Buffer.alloc(MAX_BEARER_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      // oxlint-disable-next-line no-await-in-loop -- each read continues the last
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    return length > MAX_BEARER_FILE_BYTES
      ? { failure: 'unreadable' }
      : { text: buffer.toString('utf8', 0, length) };
  } catch {
    return { failure: 'unreadable' };
  } finally {
    await file.close();
  }
};

// Reads an HTTP Service's bearer, as a Link does when it starts. The file must
// be a regular file of at most MAX_BEARER_FILE_BYTES. Without
// `bearer_key`, the secret is the file's contents without surrounding
// whitespace; with it, the string at that dotted path of the file parsed as
// TOML, used as it is.
export const readServiceBearer = async (
  service: Pick<HttpServiceConfig, 'bearer_file' | 'bearer_key'>,
  home: string,
): Promise<BearerRead> => {
  const file = await readBearerFile(expandHome(service.bearer_file, home));
  if ('failure' in file) {
    return failed(file.failure);
  }
  const { text } = file;
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
