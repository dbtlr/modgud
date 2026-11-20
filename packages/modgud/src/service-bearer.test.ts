import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
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

  test("reads a secret that spells a failure's name as the secret", async () => {
    expect(await readEach(['missing', 'unreadable'])).toEqual([
      { kind: 'read', secret: 'missing' },
      { kind: 'read', secret: 'unreadable' },
    ]);
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

  test('never takes a string a table only inherits, even from a polluted prototype', async () => {
    const path = await fileWith('tokens.toml', NORN_TOKENS);
    // oxlint-disable-next-line no-extend-native -- the test pollutes the prototype on purpose
    Object.defineProperty(Object.prototype, 'inherited', {
      configurable: true,
      value: 'inherited-secret',
    });
    try {
      const results = await Promise.all(
        ['inherited', 'tokens.inherited', 'tokens.default.inherited'].map(async (key) =>
          readServiceBearer({ bearer_file: path, bearer_key: key }, home),
        ),
      );
      expect(results).toEqual(
        Array.from({ length: 3 }, () => ({ failure: 'no string at path', kind: 'failed' })),
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>).inherited;
    }
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
  test('fails with missing for a file that does not exist, or under a missing directory or a file', async () => {
    const file = await fileWith('file', 'plain-secret');
    const results = await Promise.all(
      [join(home, 'absent'), join(home, 'absent', 'token'), join(file, 'token')].map(async (path) =>
        readServiceBearer({ bearer_file: path }, home),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({ failure: 'missing', kind: 'failed' })),
    );
  });

  test('fails with unreadable for a directory', async () => {
    expect(await readServiceBearer({ bearer_file: home }, home)).toEqual({
      failure: 'unreadable',
      kind: 'failed',
    });
  });

  test('fails with unreadable for a FIFO without a writer, at once, instead of waiting for one', async () => {
    const path = join(home, 'fifo');
    expect(await Bun.spawn(['mkfifo', path]).exited).toBe(0);
    expect(await readServiceBearer({ bearer_file: path }, home)).toEqual({
      failure: 'unreadable',
      kind: 'failed',
    });
  });

  test('fails with unreadable for a device that never ends, instead of reading it forever', async () => {
    expect(await readServiceBearer({ bearer_file: '/dev/zero' }, home)).toEqual({
      failure: 'unreadable',
      kind: 'failed',
    });
  });

  test('fails with unreadable for a device that ends at once, though it reads as empty', async () => {
    expect(await readServiceBearer({ bearer_file: '/dev/null' }, home)).toEqual({
      failure: 'unreadable',
      kind: 'failed',
    });
  });

  // procfs files report a size of 0 whatever they hold, so only the read
  // itself shows that this one is larger than 64 KiB.
  test.skipIf(process.platform !== 'linux')(
    'fails with unreadable for a file that reports a small size but holds more than 64 KiB',
    async () => {
      // The file must open as a regular file that reports a size of 0, or the
      // reader refuses it before the read and the check after it goes untested.
      const handle = await open('/proc/kallsyms');
      const stats = await handle.stat();
      await handle.close();
      expect(stats.isFile() && stats.size === 0).toBe(true);
      expect(await readServiceBearer({ bearer_file: '/proc/kallsyms' }, home)).toEqual({
        failure: 'unreadable',
        kind: 'failed',
      });
    },
  );

  test('reads a file of up to 64 KiB, and fails with unreadable for a larger one', async () => {
    const largest = await fileWith('largest', 'a'.repeat(64 * 1024));
    const larger = await fileWith('larger', 'a'.repeat(64 * 1024 + 1));
    expect(await readServiceBearer({ bearer_file: largest }, home)).toEqual({
      kind: 'read',
      secret: 'a'.repeat(64 * 1024),
    });
    expect(await readServiceBearer({ bearer_file: larger }, home)).toEqual({
      failure: 'unreadable',
      kind: 'failed',
    });
  });

  test('keeps its answer when closing the file fails, instead of throwing', async () => {
    const path = await fileWith('token', 'plain-secret');
    const handle = await open(path);
    const prototype: { close: (this: unknown) => Promise<void> } = Object.getPrototypeOf(handle);
    await handle.close();
    const { close: realClose } = prototype;
    // Closes the descriptor, then reports a failure, as a close that hit EIO would.
    const close = spyOn(prototype, 'close').mockImplementation(async function close(this: unknown) {
      await realClose.call(this);
      throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
    });
    try {
      expect(await readServiceBearer({ bearer_file: path }, home)).toEqual({
        kind: 'read',
        secret: 'plain-secret',
      });
      expect(await readServiceBearer({ bearer_file: '/dev/null' }, home)).toEqual({
        failure: 'unreadable',
        kind: 'failed',
      });
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
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
