import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import type { Connect } from './metadata-document.ts';
import { pinnedHttpsConnect } from './pinned-https.ts';
import { CERTIFICATE, METADATA_HOST, PRIVATE_KEY } from './testing/metadata-tls.ts';

type Seen = { accept?: string; host?: string; path?: string; servername?: string };

const seen: Seen[] = [];
let server: Server;
let port = 0;
const proxyVariables = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY'];
const savedProxy = new Map(proxyVariables.map((name) => [name, process.env[name]]));

beforeAll(async () => {
  // A proxy that is not there: a connection that used it would fail.
  for (const name of proxyVariables) {
    process.env[name] = 'http://127.0.0.1:9';
  }
  server = createServer({ cert: CERTIFICATE, key: PRIVATE_KEY }, (request, response) => {
    const socket = request.socket as TLSSocket & { servername?: string };
    seen.push({
      ...(request.headers.accept === undefined ? {} : { accept: request.headers.accept }),
      ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
      ...(request.url === undefined ? {} : { path: request.url }),
      ...(typeof socket.servername === 'string' ? { servername: socket.servername } : {}),
    });
    if (request.url === '/moved.json') {
      response.writeHead(302, { Location: `https://${METADATA_HOST}/client.json` });
      response.end();
      return;
    }
    response.writeHead(200, { 'Cache-Control': 'max-age=600', 'Content-Type': 'application/json' });
    response.end('{"client_id":"x"}');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  ({ port } = server.address() as AddressInfo);
});

afterAll(() => {
  server.close();
  for (const [name, value] of savedProxy) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const text = async (body: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

// The test server's port is known only once it listens.
const connect: Connect = async (request) => pinnedHttpsConnect({ ca: CERTIFICATE, port })(request);

test('connects to the checked address, never resolving the name, with the URL host as TLS server name and Host, ignoring proxy settings', async () => {
  seen.length = 0;
  // metadata.example is reserved and resolves nowhere, so only the address
  // given can have been reached; the proxy variables name a closed port.
  const response = await connect({
    address: '127.0.0.1',
    signal: new AbortController().signal,
    url: new URL(`https://${METADATA_HOST}/client.json`),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('max-age=600');
  expect(await text(response.body)).toBe('{"client_id":"x"}');
  expect(seen).toEqual([
    {
      accept: 'application/json',
      host: METADATA_HOST,
      path: '/client.json',
      servername: METADATA_HOST,
    },
  ]);
});

test("verifies the certificate against the URL's host, not the address", async () => {
  const attempt = connect({
    address: '127.0.0.1',
    signal: new AbortController().signal,
    url: new URL('https://other.example/client.json'),
  });

  // oxlint-disable-next-line typescript/await-thenable -- bun:test's rejects is awaitable
  await expect(attempt).rejects.toThrow();
});

test('does not follow a redirect', async () => {
  seen.length = 0;
  const response = await connect({
    address: '127.0.0.1',
    signal: new AbortController().signal,
    url: new URL(`https://${METADATA_HOST}/moved.json`),
  });

  expect(response.status).toBe(302);
  expect(seen.map(({ path }) => path)).toEqual(['/moved.json']);
});

test('ends the connection when the signal aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  const attempt = connect({
    address: '127.0.0.1',
    signal: controller.signal,
    url: new URL(`https://${METADATA_HOST}/client.json`),
  });

  // oxlint-disable-next-line typescript/await-thenable -- bun:test's rejects is awaitable
  await expect(attempt).rejects.toThrow();
});
