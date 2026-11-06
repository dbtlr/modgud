import { describe, expect, test } from 'bun:test';

import type { Log } from './log.ts';
import { cacheLifetimeMs, createMetadataDocumentFetcher } from './metadata-document.ts';
import type { Connect, MetadataResponse, ResolvedAddress } from './metadata-document.ts';

const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const PUBLIC_ADDRESS = '93.184.215.14';
const MINUTE = 60_000;

const DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
};

const response = (
  body: unknown,
  { headers = {}, status = 200 }: { headers?: Record<string, string>; status?: number } = {},
): MetadataResponse => {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    body: (async function* chunks() {
      await Promise.resolve();
      yield bytes;
    })(),
    headers: new Headers(headers),
    status,
  };
};

// A fetcher with a clock, a resolver, and a connector the test controls, and
// a record of every connection it opened.
const setUp = ({
  addresses = [{ address: PUBLIC_ADDRESS, family: 4 }],
  connect = async () => response(DOCUMENT),
  interfaceAddresses = [],
  timeoutMs = 5000,
}: {
  addresses?: ResolvedAddress[];
  connect?: Connect;
  interfaceAddresses?: string[];
  timeoutMs?: number;
} = {}) => {
  const clock = { now: 1_000_000 };
  const lines: string[] = [];
  const log: Log = { info: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const resolved: string[] = [];
  const connections: { address: string; url: string }[] = [];
  const fetchDocument = createMetadataDocumentFetcher({
    connect: async (request) => {
      connections.push({ address: request.address, url: request.url.href });
      return connect(request);
    },
    interfaceAddresses: () => interfaceAddresses,
    log,
    now: () => clock.now,
    resolve: async (hostname) => {
      resolved.push(hostname);
      return addresses;
    },
    timeoutMs,
  });
  return { clock, connections, fetchDocument, lines, resolved };
};

// A document of exactly `size` bytes.
const padded = (size: number) => {
  const text = JSON.stringify({ ...DOCUMENT, padding: '' });
  return JSON.stringify({ ...DOCUMENT, padding: 'x'.repeat(size - text.length) });
};

// A body that never ends, counting each chunk read.
async function* endlessBody(onChunk: () => void) {
  for (;;) {
    onChunk();
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time
    await Promise.resolve();
    yield new Uint8Array(1024);
  }
}

// A body that sends one byte and then nothing.
async function* stalledBody() {
  yield new TextEncoder().encode('{');
  await Promise.withResolvers<never>().promise;
}

const idOf = (index: number) => `https://client${String(index)}.example/client.json`;

// Fetches a document served with the Cache-Control header, and returns a
// probe of whether it still comes from the cache at a given age.
const cachedFor = async (cacheControl: string | undefined) => {
  const headers: Record<string, string> =
    cacheControl === undefined ? {} : { 'Cache-Control': cacheControl };
  const { clock, connections, fetchDocument } = setUp({
    connect: async () => response(DOCUMENT, { headers }),
  });
  await fetchDocument(CLIENT_ID);
  const start = clock.now;
  // The lifetime is the last moment the document still comes from the cache.
  const isCachedAt = async (age: number) => {
    clock.now = start + age;
    const before = connections.length;
    await fetchDocument(CLIENT_ID);
    return connections.length === before;
  };
  return isCachedAt;
};

describe('fetching a client metadata document', () => {
  test('connects to the address it checked, for the URL, and gives the validated metadata', async () => {
    const { connections, fetchDocument, resolved } = setUp();

    expect(await fetchDocument(CLIENT_ID)).toEqual({
      clientName: 'ChatGPT',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    });
    expect(resolved).toEqual(['chatgpt.com']);
    expect(connections).toEqual([{ address: PUBLIC_ADDRESS, url: CLIENT_ID }]);
  });

  test.each([
    ['a private address', '10.0.0.5'],
    ['a tailnet address', '100.100.100.100'],
    ['a loopback address', '127.0.0.1'],
    ['a NAT64 address', '64:ff9b::a00:5'],
    ['an IPv4-mapped private address', '::ffff:192.168.1.1'],
    ['a unique-local address', 'fd00::5'],
  ])('refuses a host when any address it resolves to is %s', async (_, refused) => {
    const { connections, fetchDocument, lines } = setUp({
      addresses: [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: refused, family: refused.includes(':') ? 6 : 4 },
      ],
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(connections).toEqual([]);
    expect(lines.join('\n')).toContain('chatgpt.com');
  });

  test("refuses a host that resolves to an address of the host's own interfaces", async () => {
    const { connections, fetchDocument } = setUp({ interfaceAddresses: [PUBLIC_ADDRESS] });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(connections).toEqual([]);
  });

  test('refuses a host that resolves to no address', async () => {
    const { fetchDocument } = setUp({ addresses: [] });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
  });

  test('fetches nothing for a client_id that is not a metadata URL', async () => {
    const { connections, fetchDocument, resolved } = setUp();

    expect(await fetchDocument('https://chatgpt.com:8443/oauth/client.json')).toBeUndefined();
    expect(await fetchDocument('https://chatgpt.com/')).toBeUndefined();
    expect(resolved).toEqual([]);
    expect(connections).toEqual([]);
  });

  test.each([
    ['a redirect', 302],
    ['not modified', 304],
    ['an error', 500],
    ['no content', 204],
  ])('fails on %s instead of following it', async (_, status) => {
    const { connections, fetchDocument } = setUp({
      connect: async () =>
        response(DOCUMENT, { headers: { Location: 'https://chatgpt.com/other.json' }, status }),
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(connections).toHaveLength(1);
  });

  test('accepts a document of 10 KiB and fails one larger', async () => {
    expect(padded(10 * 1024)).toHaveLength(10 * 1024);

    const fits = setUp({ connect: async () => response(padded(10 * 1024)) });
    const over = setUp({ connect: async () => response(padded(10 * 1024 + 1)) });

    expect(await fits.fetchDocument(CLIENT_ID)).toBeDefined();
    expect(await over.fetchDocument(CLIENT_ID)).toBeUndefined();
  });

  test('stops reading a body that runs past the limit', async () => {
    let chunksRead = 0;
    const { fetchDocument } = setUp({
      connect: async () => ({
        body: endlessBody(() => {
          chunksRead += 1;
        }),
        headers: new Headers(),
        status: 200,
      }),
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(chunksRead).toBeLessThan(20);
  });

  test('fails a response that does not arrive in time, and aborts its connection', async () => {
    let aborted = false;
    const { fetchDocument } = setUp({
      connect: async ({ signal }) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return Promise.withResolvers<never>().promise;
      },
      timeoutMs: 20,
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(aborted).toBe(true);
  });

  test('fails a body that does not finish in time', async () => {
    const { fetchDocument } = setUp({
      connect: async () => ({
        body: stalledBody(),
        headers: new Headers(),
        status: 200,
      }),
      timeoutMs: 20,
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
  });

  test.each([
    ['is not JSON', 'not json'],
    ['names another client_id', { ...DOCUMENT, client_id: 'https://evil.example/client.json' }],
    ['has a client_secret', { ...DOCUMENT, client_secret: 'shh' }],
    [
      'requires a client secret',
      { ...DOCUMENT, token_endpoint_auth_methods_supported: ['client_secret_basic'] },
    ],
  ])('fails a document that %s', async (_, body) => {
    const { fetchDocument } = setUp({ connect: async () => response(body) });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
  });

  test('a failure rejects without saying why to the caller, and logs the host', async () => {
    const { fetchDocument, lines } = setUp({
      connect: async () => Promise.reject(new Error('ECONNREFUSED')),
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('chatgpt.com');
  });

  test('fetches at most 30 times in any minute, across all clients', async () => {
    const { clock, connections, fetchDocument } = setUp({
      connect: async () => response('not json'),
    });
    for (let index = 0; index < 30; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one fetch after another
      await fetchDocument(CLIENT_ID);
      clock.now += 1000;
    }
    expect(connections).toHaveLength(30);

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(connections).toHaveLength(30);

    // The first fetch leaves the window a minute after it was made.
    clock.now = 1_000_000 + MINUTE + 1;
    await fetchDocument(CLIENT_ID);
    expect(connections).toHaveLength(31);
  });
});

describe('the metadata document cache', () => {
  test('keeps a valid document for its max-age', async () => {
    const isCachedAt = await cachedFor('public, max-age=1800');

    expect(await isCachedAt(30 * MINUTE - 1)).toBe(true);
    expect(await isCachedAt(30 * MINUTE)).toBe(false);
  });

  test('keeps a document for 1 hour when it has no max-age', async () => {
    const isCachedAt = await cachedFor(undefined);

    expect(await isCachedAt(60 * MINUTE - 1)).toBe(true);
    expect(await isCachedAt(60 * MINUTE)).toBe(false);
  });

  test('keeps a document for at least 5 minutes', async () => {
    const isCachedAt = await cachedFor('max-age=0');

    expect(await isCachedAt(5 * MINUTE - 1)).toBe(true);
    expect(await isCachedAt(5 * MINUTE)).toBe(false);
  });

  test('never caches a failure', async () => {
    let calls = 0;
    const { fetchDocument } = setUp({
      connect: async () => {
        calls += 1;
        return calls === 1 ? response('oops', { status: 503 }) : response(DOCUMENT);
      },
    });

    expect(await fetchDocument(CLIENT_ID)).toBeUndefined();
    expect(await fetchDocument(CLIENT_ID)).toBeDefined();
  });

  test('keeps at most 100 documents, dropping the oldest', async () => {
    const { connections, fetchDocument, clock } = setUp({
      connect: async ({ url }) => response({ ...DOCUMENT, client_id: url.href }),
    });
    for (let index = 0; index <= 100; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one fetch after another
      await fetchDocument(idOf(index));
      // Stays within the fetch budget.
      clock.now += 2 * 1000 + 1;
    }
    expect(connections).toHaveLength(101);

    await fetchDocument(idOf(100));
    await fetchDocument(idOf(1));
    expect(connections).toHaveLength(101);
    await fetchDocument(idOf(0));
    expect(connections).toHaveLength(102);
  });
});

describe('a cache lifetime', () => {
  test.each([
    [undefined, 60 * MINUTE],
    ['no-cache', 60 * MINUTE],
    ['max-age=600', 10 * MINUTE],
    ['public, max-age="600", must-revalidate', 10 * MINUTE],
    ['MAX-AGE=600', 10 * MINUTE],
    ['s-maxage=600', 60 * MINUTE],
    ['max-age=1', 5 * MINUTE],
    ['max-age=999999999', 24 * 60 * MINUTE],
  ])('for Cache-Control %p is %p ms', (header, lifetime) => {
    expect(cacheLifetimeMs(header ?? null)).toBe(lifetime);
  });
});
