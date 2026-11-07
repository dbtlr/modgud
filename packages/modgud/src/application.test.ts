import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import packageJson from '../package.json' with { type: 'json' };
import { appEnvironment } from './testing/app-environment.ts';

const directory = await mkdtemp(join(tmpdir(), 'modgud-application-'));
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

// A forced-color terminal would style the version line, so the child runs without it.
const plainEnvironment = appEnvironment(directory);

test('--version prints the application name and package version, and exits successfully', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/main.ts`, '--version'], {
    env: plainEnvironment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stdout).toMatch(/^modgud v\d+\.\d+\.\d+\n$/u);
  expect(stdout).toBe(`modgud v${packageJson.version}\n`);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
});
