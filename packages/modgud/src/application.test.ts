import { expect, test } from 'bun:test';

import packageJson from '../package.json' with { type: 'json' };

// A forced-color terminal would style the version line, so the child runs without it.
const plainEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== 'FORCE_COLOR'),
);

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
