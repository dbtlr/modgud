// Runs Public listeners serving the stub Service for integration tests, and
// speaks to them as Callers do: through the SDK client, or with raw HTTP.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { sha256Hex } from '../bearer.ts';
import { parseConfig } from '../config.ts';
import type { ChildLimits } from '../grant-child.ts';
import type { Log } from '../log.ts';
import { s256Challenge } from '../pkce.ts';
import { createPublicListener } from '../public-listener.ts';
import type { PublicListener } from '../public-listener.ts';
import { openStore } from '../store.ts';
import type { Store } from '../store.ts';

export const TOKEN = 'harness-token';
export const PUBLIC = 'https://modgud.example.com';
export const RESOURCE = `${PUBLIC}/stub/mcp`;
export const DAY = 24 * 60 * 60_000;
const STUB = `${import.meta.dir}/stub-service.ts`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

export type Running = {
  listener: PublicListener;
  lines: string[];
  url: URL;
  stop: () => Promise<void>;
  store: Store;
};

export type StartOptions = {
  authorizationSweepMs?: number;
  childLimits?: Partial<ChildLimits>;
  identityEnv?: string;
  // The Service's idle timeout, which stops its Children.
  idleMinutes?: number;
  // An argument the stub gets, so a test can find its processes.
  marker?: string;
  maxSessionsPerGrant?: number;
  origins?: string[];
  parentEnvironment?: Record<string, string | undefined>;
  sessionIdleMinutes?: number;
  storeCleanupMs?: number;
  // More of the stub's environment, such as STUB_MODE and STUB_TRACE.
  stubEnv?: Record<string, string>;
  wrapStore?: (store: Store) => Store;
};

const tomlTable = (values: Record<string, string>) =>
  `{ ${Object.entries(values)
    .map(([name, value]) => `${name} = ${JSON.stringify(value)}`)
    .join(', ')} }`;

// The listeners, stores, and directory of one test, cleaned up after it.
export const createHarness = () => {
  const running: Running[] = [];
  const stores: Store[] = [];
  let directory = '';
  // The store's clock, which decides when an authorization expires.
  let clock = Date.now();

  const setup = async () => {
    directory = await mkdtemp(join(tmpdir(), 'modgud-listener-'));
    clock = Date.now();
  };

  const teardown = async () => {
    await Promise.all(running.splice(0).map(async (instance) => instance.stop()));
    for (const store of stores.splice(0)) {
      store.close();
    }
    await rm(directory, { force: true, recursive: true });
  };

  // Opens a handle on the test's store, as the server or another process does.
  const openTestStore = async () => {
    const store = await openStore({
      maxTokenLifetimeDays: 30,
      now: () => clock,
      path: join(directory, 'modgud.sqlite'),
      resource: RESOURCE,
      warn: () => undefined,
    });
    stores.push(store);
    return store;
  };

  // Serves the stub Service as `stub`, the harness's Service, and again as
  // `other`, on a free localhost port.
  const start = async ({
    authorizationSweepMs,
    childLimits,
    identityEnv,
    idleMinutes = 30,
    marker = '',
    maxSessionsPerGrant = 64,
    origins = [],
    parentEnvironment = process.env,
    sessionIdleMinutes = 1440,
    storeCleanupMs,
    stubEnv = {},
    wrapStore = (store: Store) => store,
  }: StartOptions = {}): Promise<Running> => {
    const stub = `
      command = ${JSON.stringify(process.execPath)}
      args = ${JSON.stringify([STUB, ...(marker === '' ? [] : [marker])])}
      env = ${tomlTable({ STUB_MODE: '', STUB_SETTING: 'configured', ...stubEnv })}
      idle_timeout_minutes = ${String(idleMinutes)}
    `;
    const config = parseConfig(`
      [harness]
      bearer_token_sha256 = "${sha256Hex(TOKEN)}"
      service = "stub"

      [public]
      allowed_origins = ${JSON.stringify(origins)}
      max_sessions_per_grant = ${String(maxSessionsPerGrant)}
      session_idle_timeout_minutes = ${String(sessionIdleMinutes)}
      base_url = "${PUBLIC}"

      [admin]
      base_url = "https://modgud.example.ts.net"
      host = "100.64.0.1"

      [services.stub]
      ${stub}
      ${identityEnv === undefined ? '' : `identity_env = "${identityEnv}"`}

      [services.other]
      ${stub}
    `);
    const lines: string[] = [];
    const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
    const store = await openTestStore();
    const listener = createPublicListener({
      config,
      log,
      parentEnvironment,
      store: wrapStore(store),
      ...(authorizationSweepMs === undefined ? {} : { authorizationSweepMs }),
      ...(childLimits === undefined ? {} : { childLimits }),
      ...(storeCleanupMs === undefined ? {} : { storeCleanupMs }),
    });
    const server = Bun.serve({
      fetch: listener.fetch,
      hostname: '127.0.0.1',
      idleTimeout: 60,
      port: 0,
    });
    const instance: Running = {
      lines,
      listener,
      stop: async () => {
        await listener.close();
        await server.stop(true);
      },
      store,
      url: new URL('/stub/mcp', server.url),
    };
    running.push(instance);
    return instance;
  };

  return {
    advanceClock: (ms: number) => {
      clock += ms;
    },
    get directory() {
      return directory;
    },
    openTestStore,
    setup,
    start,
    teardown,
  };
};

// Approves a new client for the harness Service and exchanges its code, as a
// chat client does through the Approval page and the token endpoint.
export const connectOAuthClient = (store: Store) => {
  const clientId = store.registerClient({ redirectUris: [REDIRECT] })?.clientId ?? '';
  const { code: pairingCode } = store.mintPairingCode(10);
  const approved = store.approve({
    clientId,
    codeChallenge: s256Challenge(VERIFIER),
    pairingCode,
    redirectUri: REDIRECT,
    requestedRedirectUri: null,
  });
  const result = store.exchangeAuthorizationCode({
    clientId,
    code: approved?.code ?? '',
    codeVerifier: VERIFIER,
  });
  if (!result.ok) {
    throw new Error(`The exchange failed: ${result.error}`);
  }
  return { ...result.tokens, clientId };
};

// Command lines of the running processes that contain the marker.
export const processesWith = async (marker: string) => {
  const ps = Bun.spawn(['ps', '-A', '-ww', '-o', 'args='], { stdout: 'pipe' });
  const output = await new Response(ps.stdout).text();
  return output.split('\n').filter((line) => line.includes(marker));
};

export const connect = async (
  url: URL,
  {
    negotiation = 'legacy',
    token = TOKEN,
  }: { negotiation?: 'auto' | 'legacy'; token?: string } = {},
) => {
  const client = new Client(
    { name: 'test-caller', version: '1.0.0' },
    { capabilities: { roots: {} }, versionNegotiation: { mode: negotiation } },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The text of a tool result's first content block.
export const firstText = (result: Awaited<ReturnType<Client['callTool']>>) => {
  const block: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  return isRecord(block) && typeof block.text === 'string' ? block.text : undefined;
};

// The message a promise rejects with, or undefined when it resolves.
export const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

// Lets a request run without waiting for it, ignoring how it ends, as when
// its stream stays open until the listener closes.
export const inBackground = (task: Promise<unknown>) => {
  void rejectionOf(task);
};

export const initializeBodyFor = (protocolVersion: string) =>
  JSON.stringify({
    id: 1,
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'raw', version: '1' },
      protocolVersion,
    },
  });

export const initializeBody = initializeBodyFor('2025-11-25');

export const post = async (url: URL, headers: Record<string, string>, body = initializeBody) =>
  fetch(url, {
    body,
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });

// The JSON-RPC messages in an event stream's text.
export const eventMessages = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice(6)))
    .filter(isRecord);

// Opens a Session with raw HTTP: `initialize`, then the Caller's
// `notifications/initialized`. Returns the headers later requests on it
// carry and the initialize result.
export const openRawSession = async (
  url: URL,
  { protocolVersion = '2025-11-25', token = TOKEN } = {},
) => {
  const auth = { Authorization: `Bearer ${token}` };
  const opened = await post(url, auth, initializeBodyFor(protocolVersion));
  if (opened.status !== 200) {
    throw new Error(`initialize got HTTP ${String(opened.status)}`);
  }
  const [answer] = eventMessages(await opened.text());
  const answered = isRecord(answer?.result) ? answer.result : {};
  const result: Record<string, unknown> & { protocolVersion: string } = {
    ...answered,
    protocolVersion: typeof answered.protocolVersion === 'string' ? answered.protocolVersion : '',
  };
  const headers = {
    ...auth,
    'Mcp-Protocol-Version': result.protocolVersion,
    'Mcp-Session-Id': opened.headers.get('mcp-session-id') ?? '',
  };
  const initialized = await post(
    url,
    headers,
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  );
  if (initialized.status !== 202) {
    throw new Error(`notifications/initialized got HTTP ${String(initialized.status)}`);
  }
  return { headers, result };
};

// Sends one JSON-RPC request on a raw Session and returns the messages on its
// stream once the stream closes.
export const requestOn = async (
  url: URL,
  headers: Record<string, string>,
  request: { id: number | string; method: string; params?: Record<string, unknown> },
) => {
  const response = await post(url, headers, JSON.stringify({ jsonrpc: '2.0', ...request }));
  return { messages: eventMessages(await response.text()), status: response.status };
};

export const toolCall = (
  id: number | string,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  id,
  method: 'tools/call',
  params: { arguments: args, name },
});

// Whether a process with this id exists, counting one that has exited but has
// not yet been reaped.
export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  // oxlint-disable-next-line no-await-in-loop -- polling waits on purpose
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling waits on purpose
    await Bun.sleep(10);
  }
};

// Log lines of the Children that started.
export const childStarts = (lines: string[]) =>
  lines.filter((line) => / child for .+ started, pid \d+\.$/u.test(line));
