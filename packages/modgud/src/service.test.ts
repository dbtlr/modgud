import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockProcess } from '@loomcli/testing';
import type { ProgramCall } from '@loomcli/testing';

import { app } from './application.ts';

// `modgud service` is Loom's service plugin. These tests check how Modgud wires
// it: run in-process as a compiled binary would run, against a fake systemctl
// and loginctl, so no real user manager is touched.

const directory = await mkdtemp(join(tmpdir(), 'modgud-service-'));
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const binary = '/opt/modgud/bin/modgud';
const fakeBin = '/opt/fake-bin';

// Runs `modgud service ...args` with a fresh home, recording each manager call.
const runService = async (home: string, ...args: string[]) => {
  const calls: string[] = [];
  const manager = (name: string) => (call: ProgramCall) => {
    const words = call.args.join(' ');
    calls.push(`${name} ${words}`);
    if (words.endsWith('--property=ActiveState,MainPID')) {
      return { stdout: 'ActiveState=active\nMainPID=4120\n' };
    }
    return words.endsWith('--property=Linger') ? { stdout: 'Linger=yes\n' } : {};
  };
  const programs = Object.fromEntries(
    ['systemctl', 'loginctl'].flatMap((name) => [
      [name, manager(name)],
      [join(fakeBin, name), manager(name)],
    ]),
  );
  const mock = mockProcess({
    argv: ['service', ...args],
    cwd: home,
    env: { HOME: home, PATH: fakeBin },
    platform: 'linux',
    program: [binary],
    programs,
    release: { build: 'distributed' },
  });
  await app.run({ process: mock });
  return { calls, mock };
};

test('service install writes a user unit that runs plain `modgud serve` from home, and starts it', async () => {
  const home = await mkdtemp(join(directory, 'home-'));

  const { calls, mock } = await runService(home, 'install');

  expect(mock.exitCode).toBe(0);
  const unit = await readFile(
    join(home, '.config', 'systemd', 'user', 'com.dbtlr.modgud.service'),
    'utf8',
  );
  expect(unit).toContain(`ExecStart="${binary}" "serve"\n`);
  expect(unit).toContain(`WorkingDirectory=${home}\n`);
  expect(unit).toContain('SuccessExitStatus=130 143\n');
  expect(unit).not.toContain('Environment');
  expect(calls).toContain('systemctl --user enable com.dbtlr.modgud.service');
  expect(calls).toContain('systemctl --user restart com.dbtlr.modgud.service');
});

test('service status reports the running unit and exits 0', async () => {
  const home = await mkdtemp(join(directory, 'home-'));
  await runService(home, 'install');

  const { mock } = await runService(home, 'status');

  expect(mock.exitCode).toBe(0);
  expect(mock.stdout.text).toStartWith('com.dbtlr.modgud: running (pid 4120)');
});
