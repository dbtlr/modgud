import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readServiceBearer } from './service-bearer.ts';

let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'modgud-bearer-'));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

// Writes `text` to `name` under the test's home and returns its absolute path.
const fileWith = async (name: string, text: string) => {
  const path = join(home, name);
  await writeFile(path, text);
  return path;
};

// What each text reads as without bearer_key, each written to its own file.
const readEach = async (texts: readonly string[]) =>
  Promise.all(
    texts.map(async (text, index) =>
      readServiceBearer({ bearer_file: await fileWith(`token-${String(index)}`, text) }, home),
    ),
  );

const NORN_TOKENS = `
[tokens.default]
secret = "norn-secret-1"

[tokens.backup]
secret = "norn-secret-2"
`;

describe('readServiceBearer without bearer_key', () => {
  test('reads the whole file as the secret, without surrounding whitespace', async () => {
    const path = await fileWith('token', '  plain-secret\n\n');
    expect(await readServiceBearer({ bearer_file: path }, home)).toEqual({
      kind: 'read',
      secret: 'plain-secret',
    });
  });

  test('expands a leading ~/ to home', async () => {
    await mkdir(join(home, '.config'));
    await fileWith('.config/token', 'plain-secret');
    expect(await readServiceBearer({ bearer_file: '~/.config/token' }, home)).toEqual({
      kind: 'read',
      secret: 'plain-secret',
    });
  });

  test('refuses an empty file, or one with only whitespace, as an invalid secret', async () => {
    expect(await readEach(['', ' \n\t\n'])).toEqual(
      Array.from({ length: 2 }, () => ({ failure: 'invalid secret', kind: 'failed' })),
    );
  });

  test('refuses a secret with any character other than visible ASCII', async () => {
    const texts = ['two words', 'tab\there', 'line\nbreak', 'café', 'nul\u0000', 'del\u007f'];
    expect(await readEach(texts)).toEqual(
      texts.map(() => ({ failure: 'invalid secret', kind: 'failed' })),
    );
  });

  test('accepts every visible ASCII character', async () => {
    let visible = '';
    // From ! (33) through ~ (126).
    for (let code = 33; code <= 126; code += 1) {
      visible += String.fromCodePoint(code);
    }
    const path = await fileWith('token', visible);
    expect(await readServiceBearer({ bearer_file: path }, home)).toEqual({
      kind: 'read',
      secret: visible,
    });
  });
});

describe('readServiceBearer with bearer_key', () => {
  test("takes the string at the dotted path, as in Norn's token file", async () => {
    const path = await fileWith('tokens.toml', NORN_TOKENS);
    expect(
      await readServiceBearer({ bearer_file: path, bearer_key: 'tokens.backup.secret' }, home),
    ).toEqual({ kind: 'read', secret: 'norn-secret-2' });
  });

  test('takes a top-level key', async () => {
    const path = await fileWith('token.toml', 'secret = "top-secret"\n');
    expect(await readServiceBearer({ bearer_file: path, bearer_key: 'secret' }, home)).toEqual({
      kind: 'read',
      secret: 'top-secret',
    });
  });

  test('uses the string as it is, so surrounding whitespace makes it invalid', async () => {
    const path = await fileWith('token.toml', 'secret = " padded "\n');
    expect(await readServiceBearer({ bearer_file: path, bearer_key: 'secret' }, home)).toEqual({
      failure: 'invalid secret',
      kind: 'failed',
    });
  });

  test('fails with no string at path for a missing key or a value that is not a string', async () => {
    const path = await fileWith(
      'tokens.toml',
      `${NORN_TOKENS}\n[numbers]\nsecret = 42\nlist = ["a"]\n`,
    );
    const keys = [
      'tokens.other.secret',
      'tokens.default',
      'tokens.default.secret.deeper',
      'numbers.secret',
      'numbers.list',
      'numbers.list.0',
      'tokens.__proto__',
      'tokens.constructor',
      'toString',
    ];
    const results = await Promise.all(
      keys.map(async (key) => readServiceBearer({ bearer_file: path, bearer_key: key }, home)),
    );
    expect(results).toEqual(keys.map(() => ({ failure: 'no string at path', kind: 'failed' })));
  });

  test("fails with not TOML for a file the parser refuses, and never carries the parser's message", async () => {
    // Bun's TOML parser quotes an unquoted value in its error message, so a
    // secret written without quotes would reach the log through it.
    const path = await fileWith('tokens.toml', '[tokens.default]\nsecret = leaked-secret-value\n');
    const result = await readServiceBearer(
      { bearer_file: path, bearer_key: 'tokens.default.secret' },
      home,
    );
    expect(result).toEqual({ failure: 'not TOML', kind: 'failed' });
    expect(JSON.stringify(result)).not.toContain('leaked-secret-value');
  });
});

describe('readServiceBearer file failures', () => {
  test('fails with missing for a file that does not exist, or under a missing directory', async () => {
    const results = await Promise.all(
      [join(home, 'absent'), join(home, 'absent', 'token')].map(async (path) =>
        readServiceBearer({ bearer_file: path }, home),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: 2 }, () => ({ failure: 'missing', kind: 'failed' })),
    );
  });

  test('fails with unreadable for a directory', async () => {
    expect(await readServiceBearer({ bearer_file: home }, home)).toEqual({
      failure: 'unreadable',
      kind: 'failed',
    });
  });

  test.skipIf(process.getuid?.() === 0)(
    'fails with unreadable for a file it has no permission to read',
    async () => {
      const path = await fileWith('token', 'plain-secret');
      await chmod(path, 0o000);
      expect(await readServiceBearer({ bearer_file: path }, home)).toEqual({
        failure: 'unreadable',
        kind: 'failed',
      });
    },
  );
});
