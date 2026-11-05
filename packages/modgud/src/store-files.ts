import type { Stats } from 'node:fs';
import { chmod, mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const GROUP_OR_OTHERS_WRITE = 0o022;
const GROUP_OR_OTHERS_ANY = 0o077;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const statOrUndefined = async (path: string): Promise<Stats | undefined> => {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
};

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, '0');

// Creates the store's directory with mode 0700 when it is absent, and refuses
// an existing one that group or others can write or another account owns.
const secureDirectory = async (directory: string, uid: number | undefined) => {
  const existing = await statOrUndefined(directory);
  if (existing === undefined) {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY, recursive: true });
    await chmod(directory, PRIVATE_DIRECTORY);
    return;
  }
  if (!existing.isDirectory()) {
    throw new Error(`The store directory ${directory} is not a directory.`);
  }
  if (uid !== undefined && existing.uid !== uid) {
    throw new Error(
      `The store directory ${directory} is owned by another account. Run Modgud as its owner, or set store.path to a directory this account owns.`,
    );
  }
  if ((existing.mode & GROUP_OR_OTHERS_WRITE) !== 0) {
    throw new Error(
      `The store directory ${directory} is writable by group or others (mode ${octal(existing.mode)}). Run chmod 700 ${directory}.`,
    );
  }
};

// Sets one existing file to mode 0600, warning when its mode was wider.
const narrowFile = async (file: string, warn: (message: string) => void) => {
  const existing = await statOrUndefined(file);
  if (existing === undefined || (existing.mode & GROUP_OR_OTHERS_ANY) === 0) {
    return;
  }
  try {
    await chmod(file, PRIVATE_FILE);
  } catch (error) {
    throw new Error(`Could not set ${file} to mode 0600: ${describeError(error)}`, {
      cause: error,
    });
  }
  warn(`Set ${file} from mode ${octal(existing.mode)} to 0600.`);
};

// Checks the store's directory and files before Modgud or a command reads the
// store (docs/oauth.md, "Store"). It creates an absent directory with mode
// 0700 and an absent database file with mode 0600, refuses an unsafe
// directory, and narrows the database and SQLite's -wal, -shm, and -journal
// files to 0600. Throws an Error that names the path and how to fix it.
export const secureStoreFiles = async (
  path: string,
  warn: (message: string) => void,
  uid: number | undefined = process.getuid?.(),
) => {
  await secureDirectory(dirname(path), uid);
  // Creating the file first gives it mode 0600 from the start, and SQLite
  // gives its -wal, -shm, and -journal files the database file's mode.
  await (await open(path, 'a', PRIVATE_FILE)).close();
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    // oxlint-disable-next-line no-await-in-loop -- each warning names its file in order
    await narrowFile(file, warn);
  }
};
