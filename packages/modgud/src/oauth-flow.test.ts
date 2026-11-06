import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  auth,
} from '@modelcontextprotocol/client';
import type {
  FetchLike,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import { createAdminListener } from './admin-listener.ts';
import type { AdminListener } from './admin-listener.ts';
import { sha256Hex } from './bearer.ts';
import { parseConfig } from './config.ts';
import type { Log } from './log.ts';
import { createMetadataDocumentFetcher } from './metadata-document.ts';
import type { FetchMetadataDocument } from './metadata-document.ts';
import { createPublicListener } from './public-listener.ts';
import type { PublicListener } from './public-listener.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';

// The whole OAuth flow, driven by the MCP SDK's own OAuth client against an
// in-process Public listener and Admin listener serving the stub Service:
// the 401, discovery, registration or a metadata document, the Approval page
// as a browser loads and submits it, the code exchange, MCP calls with the
// access token, refresh rotation, and revocation.

const PUBLIC = 'https://modgud.example.com';
const ADMIN = 'https://modgud.example.ts.net';
const SERVICE_URL = `${PUBLIC}/stub/mcp`;
const REDIRECT = 'https://client.example/oauth/callback';
const METADATA_URL = 'https://client.example/oauth/metadata.json';
const STUB = `${import.meta.dir}/testing/stub-service.ts`;

const config = parseConfig(`
  [harness]
  bearer_token_sha256 = "${sha256Hex('unused')}"
  service = "stub"

  [public]
  base_url = "${PUBLIC}"

  [admin]
  base_url = "${ADMIN}"
  host = "100.64.0.1"

  [services.stub]
  command = ${JSON.stringify(process.execPath)}
  args = [${JSON.stringify(STUB)}]
`);

type Running = {
  admin: AdminListener;
  lines: string[];
  publicListener: PublicListener;
  store: Store;
};

let directory = '';
let running: Running | undefined;
const clients: Client[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'modgud-flow-'));
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => client.close()));
  if (running !== undefined) {
    running.admin.close();
    await running.publicListener.close();
    running.store.close();
    running = undefined;
  }
  await rm(directory, { force: true, recursive: true });
});

const start = async (fetchMetadataDocument?: FetchMetadataDocument): Promise<Running> => {
  const lines: string[] = [];
  const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const store = await openStore({
    maxTokenLifetimeDays: 30,
    path: join(directory, 'modgud.sqlite'),
    resource: SERVICE_URL,
    warn: () => undefined,
  });
  running = {
    admin: createAdminListener({
      config,
      log,
      store,
      ...(fetchMetadataDocument === undefined ? {} : { fetchMetadataDocument }),
    }),
    lines,
    publicListener: createPublicListener({
      authorizationSweepMs: 50,
      config,
      log,
      parentEnvironment: process.env,
      store,
    }),
    store,
  };
  return running;
};

// The network as the chat client sees it: Modgud's public base URL reaches
// the in-process Public listener. Nothing else is reachable.
const publicNetwork =
  (listener: PublicListener): FetchLike =>
  async (url, init) => {
    const request = new Request(String(url), init ?? {});
    if (new URL(request.url).origin !== PUBLIC) {
      throw new Error(`The client fetched ${request.url}, which is not Modgud's public address.`);
    }
    return listener.fetch(request);
  };

// A chat client's OAuth state, kept in memory. It records where it would send
// the person instead of opening a browser.
const createProvider = (clientMetadataUrl?: string) => {
  const saved: {
    authorizationUrl?: URL;
    discovery?: OAuthDiscoveryState;
    information?: StoredOAuthClientInformation;
    tokens?: StoredOAuthTokens;
    verifier: string;
  } = { verifier: '' };
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'Flow test client',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [REDIRECT],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  const provider: OAuthClientProvider = {
    clientInformation: () => saved.information,
    clientMetadata,
    ...(clientMetadataUrl === undefined ? {} : { clientMetadataUrl }),
    codeVerifier: () => saved.verifier,
    discoveryState: () => saved.discovery,
    // A refused refresh, as after a revoke, drops the stored tokens.
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'tokens') {
        delete saved.tokens;
      }
    },
    redirectToAuthorization: (url) => {
      saved.authorizationUrl = url;
    },
    redirectUrl: REDIRECT,
    saveClientInformation: (information) => {
      saved.information = information;
    },
    saveCodeVerifier: (verifier) => {
      saved.verifier = verifier;
    },
    saveDiscoveryState: (discovery) => {
      saved.discovery = discovery;
    },
    saveTokens: (tokens) => {
      saved.tokens = tokens;
    },
    state: () => 'flow-state',
    tokens: () => saved.tokens,
  };
  return { provider, saved };
};

const connect = async (provider: OAuthClientProvider, network: FetchLike) => {
  const transport = new StreamableHTTPClientTransport(new URL(SERVICE_URL), {
    authProvider: provider,
    fetch: network,
  });
  const client = new Client({ name: 'flow-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
};

const BROWSER = {
  Host: 'modgud.example.ts.net',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
};

// The person's browser opens the Approval page, and the person enters a
// Pairing code from `modgud pair` and approves. Returns where the browser goes.
const approveInBrowser = async ({ admin, store }: Running, authorizationUrl: URL) => {
  expect(authorizationUrl.origin).toBe(ADMIN);
  const page = await admin.fetch(new Request(authorizationUrl.href, { headers: BROWSER }));
  expect(page.status).toBe(200);
  const html = await page.text();
  const id = /name="request" value="([^"]+)"/u.exec(html)?.[1] ?? '';
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { code: pairingCode } = store.mintPairingCode(10);
  const approved = await admin.fetch(
    new Request(`${ADMIN}/authorize`, {
      body: new URLSearchParams({ action: 'approve', pairing_code: pairingCode, request: id }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        Host: 'modgud.example.ts.net',
        Origin: ADMIN,
      },
      method: 'POST',
    }),
  );
  expect(approved.status).toBe(303);
  return { html, location: new URL(approved.headers.get('location') ?? '') };
};

// A response body that arrives as one chunk.
async function* bodyOf(text: string) {
  await Promise.resolve();
  yield new TextEncoder().encode(text);
}

const echo = async (client: Client, text: string) => {
  const result = await client.callTool({ arguments: { text }, name: 'echo' });
  return result.content;
};

// The first connection: the 401 sends the client through discovery, then
// registration or its metadata document, to the Approval page; the code from
// the redirect finishes the flow.
const pairClient = async (instance: Running, clientMetadataUrl?: string) => {
  const network = publicNetwork(instance.publicListener);
  const { provider, saved } = createProvider(clientMetadataUrl);

  // oxlint-disable-next-line typescript/await-thenable -- bun:test's rejects is awaitable
  await expect(connect(provider, network)).rejects.toBeInstanceOf(UnauthorizedError);
  const authorizationUrl = saved.authorizationUrl ?? new URL('about:blank');
  expect(authorizationUrl.searchParams.get('resource')).toBe(SERVICE_URL);
  expect(authorizationUrl.searchParams.has('scope')).toBe(false);

  const { html, location } = await approveInBrowser(instance, authorizationUrl);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('flow-state');
  expect(location.searchParams.get('iss')).toBe(PUBLIC);

  const finishing = new StreamableHTTPClientTransport(new URL(SERVICE_URL), {
    authProvider: provider,
    fetch: network,
  });
  await finishing.finishAuth(location.searchParams);
  expect(saved.tokens?.access_token).toStartWith('mdg_at_');
  expect(saved.tokens?.refresh_token).toStartWith('mdg_rt_');
  return { html, network, provider, saved };
};

test('a client registers, is approved with a Pairing code, calls the Service, refreshes, and loses its Session on revoke', async () => {
  const instance = await start();
  const { network, provider, saved } = await pairClient(instance);
  expect(saved.information?.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  const { client } = await connect(provider, network);
  const { tools } = await client.listTools();
  expect(tools.map(({ name }) => name)).toContain('echo');
  expect(await echo(client, 'approved')).toEqual([{ text: 'approved', type: 'text' }]);
  expect(instance.publicListener.sessionCount()).toBe(1);

  // Refresh rotates both tokens, and the Session keeps working with the new
  // access token, which belongs to the same authorization.
  const before = saved.tokens;
  expect(await auth(provider, { fetchFn: network, serverUrl: SERVICE_URL })).toBe('AUTHORIZED');
  expect(saved.tokens?.access_token).not.toBe(before?.access_token);
  expect(saved.tokens?.refresh_token).not.toBe(before?.refresh_token);
  expect(await echo(client, 'refreshed')).toEqual([{ text: 'refreshed', type: 'text' }]);

  // `modgud revoke` from another process ends the Session within the sweep.
  expect(instance.store.revokeAll()).toBe(1);
  for (let wait = 0; wait < 100 && instance.publicListener.sessionCount() > 0; wait += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the sweep runs
    await Bun.sleep(20);
  }
  expect(instance.publicListener.sessionCount()).toBe(0);
  // oxlint-disable-next-line typescript/await-thenable -- bun:test's rejects is awaitable
  await expect(echo(client, 'revoked')).rejects.toThrow();

  const log = instance.lines.join('\n');
  expect(log).toContain('Registered client');
  expect(log).toMatch(/Approved client [\w-]{8} \(Flow test client\) as authorization [\w-]{8}\./u);
  expect(log).toContain('ended: authorization ended');
  for (const secret of [before?.access_token, before?.refresh_token, saved.tokens?.access_token]) {
    expect(log).not.toContain(secret ?? 'unset');
  }
});

test('a client identified by its metadata document pairs without registering, and its document is fetched safely', async () => {
  const fetched: { address: string; url: string }[] = [];
  const document = {
    client_id: METADATA_URL,
    client_name: 'Metadata client',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
  };
  const fetchMetadataDocument = createMetadataDocumentFetcher({
    connect: async ({ address, url }) => {
      fetched.push({ address, url: url.href });
      return {
        body: bodyOf(JSON.stringify(document)),
        headers: new Headers({ 'Content-Type': 'application/json' }),
        status: 200,
      };
    },
    interfaceAddresses: () => [],
    log: { info: () => undefined, warn: () => undefined },
    resolve: async () => [{ address: '93.184.215.14', family: 4 }],
  });
  const instance = await start(fetchMetadataDocument);

  const { html, network, provider, saved } = await pairClient(instance, METADATA_URL);

  // The metadata URL is the client_id; nothing was registered.
  expect(saved.information?.client_id).toBe(METADATA_URL);
  expect(fetched).toEqual([{ address: '93.184.215.14', url: METADATA_URL }]);
  expect(html).toContain('Client metadata from</dt><dd>client.example</dd>');
  expect(html).toContain('Metadata client');
  const { client } = await connect(provider, network);
  expect(await echo(client, 'by metadata')).toEqual([{ text: 'by metadata', type: 'text' }]);
  expect(instance.lines.join('\n')).not.toContain('Registered client');
});
