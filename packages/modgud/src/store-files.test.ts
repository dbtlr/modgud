import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { secureStoreFiles } from './store-files.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

const scratch = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modgud-store-files-'));
  directories.push(directory);
  return directory;
};

// A directory of the given mode, in its own scratch directory.
const directoryWithMode = async (mode: number) => {
  const directory = join(await scratch(), 'store');
  await mkdir(directory);
  await chmod(directory, mode);
  return directory;
};

// The message the promise rejects with.
const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('The promise resolved.');
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

const collect = () => {
  const warnings: string[] = [];
  return { warn: (message: string) => warnings.push(message), warnings };
};

describe('secureStoreFiles', async () => {
  test('creates an absent directory with mode 0700 and the file with mode 0600', async () => {
    const directory = join(await scratch(), 'state', 'modgud');
    const path = join(directory, 'modgud.sqlite');
    const { warn, warnings } = collect();

    await secureStoreFiles(path, warn);

    expect(await modeOf(directory)).toBe(0o700);
    expect(await modeOf(path)).toBe(0o600);
    expect(warnings).toEqual([]);
  });

  test('refuses an existing directory writable by group, naming it', async () => {
    const directory = await directoryWithMode(0o770);
    expect(
      await rejectionOf(secureStoreFiles(join(directory, 'modgud.sqlite'), collect().warn)),
    ).toContain(directory);
  });

  test('refuses an existing directory writable by others, naming it', async () => {
    const directory = await directoryWithMode(0o702);
    expect(
      await rejectionOf(secureStoreFiles(join(directory, 'modgud.sqlite'), collect().warn)),
    ).toContain(directory);
  });

  test('accepts an existing directory readable by others but writable only by its owner', async () => {
    const directory = await directoryWithMode(0o755);

    await secureStoreFiles(join(directory, 'modgud.sqlite'), collect().warn);

    expect(await modeOf(directory)).toBe(0o755);
  });

  test('refuses an existing directory owned by another account', async () => {
    const directory = await scratch();
    const otherAccount = (process.getuid?.() ?? 0) + 1;

    expect(
      await rejectionOf(
        secureStoreFiles(join(directory, 'modgud.sqlite'), collect().warn, otherAccount),
      ),
    ).toMatch(/another account/u);
  });

  test('narrows a wider database, -wal, -shm, or -journal file to 0600, with a warning naming each', async () => {
    const directory = await scratch();
    const path = join(directory, 'modgud.sqlite');
    const files = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
    await Promise.all(files.map(async (file) => writeFile(file, '', { mode: 0o644 })));
    await Promise.all(files.map(async (file) => chmod(file, 0o644)));
    const { warn, warnings } = collect();

    await secureStoreFiles(path, warn);

    expect(await Promise.all(files.map(modeOf))).toEqual([0o600, 0o600, 0o600, 0o600]);
    expect(warnings).toHaveLength(4);
    for (const [index, file] of files.entries()) {
      expect(warnings[index]).toContain(file);
    }
  });

  test('leaves a file already at 0600 alone, without a warning', async () => {
    const directory = await scratch();
    const path = join(directory, 'modgud.sqlite');
    await writeFile(path, '', { mode: 0o600 });
    const { warn, warnings } = collect();

    await secureStoreFiles(path, warn);

    expect(warnings).toEqual([]);
  });

  test('refuses a store path that is a symbolic link, naming it, without creating its target', async () => {
    const directory = await scratch();
    const path = join(directory, 'modgud.sqlite');
    const target = join(directory, 'elsewhere.sqlite');
    await symlink(target, path);

    const message = await rejectionOf(secureStoreFiles(path, collect().warn));

    expect(message).toContain(path);
    expect(message).toContain('symbolic link');
    expect(await exists(target)).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)('refuses a file whose mode it cannot narrow', async () => {
    const directory = await scratch();
    const path = join(directory, 'modgud.sqlite');
    // /dev/null is owned by root with mode 0666, so the narrowing fails.
    await symlink('/dev/null', `${path}-journal`);

    expect(await rejectionOf(secureStoreFiles(path, collect().warn))).toContain(`${path}-journal`);
  });
});
