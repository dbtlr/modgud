import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { s256Challenge } from './pkce.ts';
import { openStore } from './store.ts';
import { appEnvironment } from './testing/app-environment.ts';

const directory = await mkdtemp(join(tmpdir(), 'modgud-pair-'));
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const storePath = join(directory, 'state', 'modgud.sqlite');
const configPath = join(directory, 'modgud.toml');
await writeFile(
  configPath,
  `
    [harness]
    bearer_token_sha256 = "${'a'.repeat(64)}"
    service = "norn"

    [public]
    base_url = "https://modgud.example.com"

    [admin]
    base_url = "https://modgud.example.ts.net"
    host = "100.64.0.1"

    [store]
    path = ${JSON.stringify(storePath)}

    [services.norn]
    command = "norn"
  `,
);

const plainEnvironment = appEnvironment(directory);

const run = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/main.ts`, ...args], {
    env: plainEnvironment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
};

describe('modgud pair', () => {
  test('prints a Pairing code and its expiry 10 minutes out, and the code approves once', async () => {
    const before = Date.now();
    const { exitCode, stdout } = await run('pair', '--config', configPath);

    expect(exitCode).toBe(0);
    const match =
      /^Pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})\nExpires at (\S+), in 10 minutes\.\n$/u.exec(
        stdout,
      );
    expect(match).not.toBeNull();
    const expiresAt = Date.parse(match?.[2] ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);

    const store = await openStore({
      maxTokenLifetimeDays: 30,
      path: storePath,
      resource: 'https://modgud.example.com/norn/mcp',
      warn: () => undefined,
    });
    const approval = {
      clientId: 'client',
      codeChallenge: s256Challenge('a'.repeat(43)),
      pairingCode: match?.[1] ?? '',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      requestedRedirectUri: null,
    };
    expect(store.approve(approval)).toBeDefined();
    expect(store.approve(approval)).toBeUndefined();
    store.close();
  });

  test('--minutes sets the lifetime from 1 to 60', async () => {
    for (const minutes of ['1', '60']) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one process
      const { exitCode, stdout } = await run('pair', '--config', configPath, '--minutes', minutes);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`, in ${minutes} minute${minutes === '1' ? '' : 's'}.`);
    }
  });

  test('refuses --minutes outside 1 to 60 whole minutes', async () => {
    for (const minutes of ['0', '61', '1.5', 'ten']) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one process
      const { exitCode, stdout } = await run('pair', '--config', configPath, '--minutes', minutes);
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain('Pairing code');
    }
  });

  test('refuses an invalid configuration, naming the file', async () => {
    const invalid = join(directory, 'invalid.toml');
    await writeFile(invalid, '[harness]\n');

    const { exitCode, stderr } = await run('pair', '--config', invalid);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(invalid);
  });
});
