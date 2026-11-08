import { join } from 'node:path';

// Where Loom's logging plugin writes `modgud`'s log in a test run of
// `appEnvironment(directory)`.
export const logPath = (directory: string) =>
  process.platform === 'darwin'
    ? join(directory, 'Library', 'Logs', 'modgud', 'modgud.jsonl')
    : join(directory, 'xdg-state', 'modgud', 'modgud.jsonl');

// The environment a test runs `modgud` with: the test's own, without
// FORCE_COLOR so output is plain, and with Loom's log under `directory`, so a
// test keeps both platform logging defaults inside its own directory.
export const appEnvironment = (directory: string) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'FORCE_COLOR')),
  HOME: directory,
  XDG_STATE_HOME: join(directory, 'xdg-state'),
});
