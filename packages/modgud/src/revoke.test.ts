import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { s256Challenge } from './pkce.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';
import { appEnvironment } from './testing/app-environment.ts';

const directory = await mkdtemp(join(tmpdir(), 'modgud-revoke-'));
afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

const RESOURCE = 'https://modgud.example.com/norn/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(43);

const plainEnvironment = appEnvironment(directory);

// A configuration whose store lives at `storePath`.
const configure = async (name: string, storePath: string) => {
  const configPath = join(directory, `${name}.toml`);
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
  return configPath;
};

const revoke = async (configPath: string) => {
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/main.ts`, 'revoke', '--config', configPath],
    { env: plainEnvironment, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const openAt = (path: string) =>
  openStore({ maxTokenLifetimeDays: 30, path, resource: RESOURCE, warn: () => undefined });

// Registers a client and connects it, returning its tokens.
const connect = (store: Store) => {
  const clientId = store.registerClient({ redirectUris: [REDIRECT] })?.clientId ?? '';
  const approved = store.approve({
    clientId,
    codeChallenge: s256Challenge(VERIFIER),
    pairingCode: store.mintPairingCode(10).code,
    redirectUri: REDIRECT,
    requestedRedirectUri: REDIRECT,
  });
  const result = store.exchangeAuthorizationCode({
    clientId,
    code: approved?.code ?? '',
    codeVerifier: VERIFIER,
    redirectUri: REDIRECT,
  });
  if (!result.ok) {
    throw new Error('The connection failed.');
  }
  return { clientId, ...result.tokens };
};

describe('modgud revoke', () => {
  test('revokes every authorization and unspent Pairing code, keeps registrations, and prints the count', async () => {
    const storePath = join(directory, 'state', 'modgud.sqlite');
    const configPath = await configure('modgud', storePath);
    const server = await openAt(storePath);
    const first = connect(server);
    const second = connect(server);
    const { code } = server.mintPairingCode(10);

    const { exitCode, stdout } = await revoke(configPath);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('Revoked 2 authorizations.\n');
    // The server's open store sees the change on its next read.
    expect(server.verifyAccessToken(first.accessToken)).toBeUndefined();
    expect(server.verifyAccessToken(second.accessToken)).toBeUndefined();
    expect(
      server.approve({
        clientId: first.clientId,
        codeChallenge: s256Challenge(VERIFIER),
        pairingCode: code,
        redirectUri: REDIRECT,
        requestedRedirectUri: null,
      }),
    ).toBeUndefined();
    expect(server.findClient(first.clientId)).toBeDefined();
    server.close();

    expect((await revoke(configPath)).stdout).toBe('Revoked 0 authorizations.\n');
  });

  test('says "authorization" for one', async () => {
    const storePath = join(directory, 'one', 'modgud.sqlite');
    const configPath = await configure('one', storePath);
    const store = await openAt(storePath);
    connect(store);
    store.close();

    expect((await revoke(configPath)).stdout).toBe('Revoked 1 authorization.\n');
  });

  test('refuses a store directory that others can write, naming it', async () => {
    const unsafe = join(directory, 'unsafe');
    await mkdir(unsafe);
    await chmod(unsafe, 0o777);
    const configPath = await configure('unsafe', join(unsafe, 'modgud.sqlite'));

    const { exitCode, stderr } = await revoke(configPath);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(unsafe);
  });
});
