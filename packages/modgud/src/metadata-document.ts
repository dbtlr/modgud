import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

import { clientLabel, isClientIdMetadataUrl, parseMetadataDocument } from './client-metadata.ts';
import type { ClientMetadata } from './client-metadata.ts';
import { isPublicUnicastAddress } from './ip-address.ts';
import { loggable } from './log.ts';
import type { Log } from './log.ts';
import { pinnedHttpsConnect } from './pinned-https.ts';
import { createWindowLimit } from './rate-limit.ts';

// Fetches Client ID Metadata Documents safely (docs/oauth.md, "Client
// metadata documents"): only from public unicast addresses that are not the
// host's own, connecting to the address it checked without resolving the name
// again, with no redirects, within 5 seconds and 10 KiB, at most 30 times a
// minute, and caching only valid documents.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const BODY_LIMIT = 10 * 1024;
const TIMEOUT_MS = 5 * SECOND;
const FETCHES_PER_MINUTE = 30;
const CACHED_DOCUMENTS = 100;
const SHORTEST_LIFETIME = 5 * MINUTE;
const DEFAULT_LIFETIME = HOUR;
const LONGEST_LIFETIME = 24 * HOUR;

export type ResolvedAddress = { address: string; family: number };

// Every address a host name resolves to.
export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

export type MetadataResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
};

// Requests `url` from `address`, with the TLS server name and `Host` set to
// the URL's host and without consulting DNS. Aborting `signal` ends the
// connection.
export type Connect = (request: {
  address: string;
  url: URL;
  signal: AbortSignal;
}) => Promise<MetadataResponse>;

// Gives the client's metadata, or undefined when the document cannot be
// fetched or is not valid. It never says why: the log does.
export type FetchMetadataDocument = (clientId: string) => Promise<ClientMetadata | undefined>;

const systemResolve: Resolve = async (hostname) =>
  lookup(hostname, { all: true, order: 'verbatim' });

const ownInterfaceAddresses = () =>
  Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).map(({ address }) => address),
  );

// How long a document stays cached: its `Cache-Control` max-age, clamped to
// between 5 minutes and 24 hours, or 1 hour without one.
export const cacheLifetimeMs = (cacheControl: string | null) => {
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/iu.exec(cacheControl ?? '')?.[1];
  if (maxAge === undefined) {
    return DEFAULT_LIFETIME;
  }
  return Math.min(Math.max(Number(maxAge) * SECOND, SHORTEST_LIFETIME), LONGEST_LIFETIME);
};

// A reason a fetch failed, for the log only.
class FetchFailureError extends Error {
  override name = 'FetchFailureError';
}

// The body as text, failing once it passes the limit.
const readLimited = async (body: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > BODY_LIMIT) {
      throw new FetchFailureError(`the document is larger than ${String(BODY_LIMIT)} bytes`);
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

// Settles with the task, or fails once `timeoutMs` passes. Either way it
// aborts the signal it gave the task, which ends any connection still open.
const withinTime = async <T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>) => {
  const controller = new AbortController();
  const timeUp = Promise.withResolvers<never>();
  controller.signal.addEventListener('abort', () => {
    timeUp.reject(new FetchFailureError('the response did not arrive in time'));
  });
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([task(controller.signal), timeUp.promise]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

export const createMetadataDocumentFetcher = ({
  connect = pinnedHttpsConnect(),
  interfaceAddresses = ownInterfaceAddresses,
  log,
  now = Date.now,
  resolve = systemResolve,
  timeoutMs = TIMEOUT_MS,
}: {
  connect?: Connect;
  // The addresses of the host's own interfaces, read at every fetch.
  interfaceAddresses?: () => readonly string[];
  log: Log;
  now?: () => number;
  resolve?: Resolve;
  timeoutMs?: number;
}): FetchMetadataDocument => {
  // Valid documents by URL, oldest first.
  const cache = new Map<string, { expiresAt: number; metadata: ClientMetadata }>();
  const budget = createWindowLimit({ limit: FETCHES_PER_MINUTE, now, windowMs: MINUTE });

  const download = async (url: URL, signal: AbortSignal) => {
    const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1');
    const addresses = await resolve(hostname);
    const own = interfaceAddresses();
    const [first] = addresses;
    if (first === undefined) {
      throw new FetchFailureError('its host resolves to no address');
    }
    const refused = addresses.find(({ address }) => !isPublicUnicastAddress(address, own));
    if (refused !== undefined) {
      throw new FetchFailureError(`its host resolves to ${refused.address}, which is not public`);
    }
    const response = await connect({ address: first.address, signal, url });
    if (response.status !== 200) {
      throw new FetchFailureError(`the response was HTTP ${String(response.status)}`);
    }
    return {
      cacheControl: response.headers.get('cache-control'),
      text: await readLimited(response.body),
    };
  };

  const fetchAndValidate = async (clientId: string) => {
    const { cacheControl, text } = await withinTime(timeoutMs, async (signal) =>
      download(new URL(clientId), signal),
    );
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new FetchFailureError('the document is not JSON');
    }
    const metadata = parseMetadataDocument(clientId, document);
    if (metadata === undefined) {
      throw new FetchFailureError('the document is not a valid client metadata document');
    }
    return { lifetime: cacheLifetimeMs(cacheControl), metadata };
  };

  const remember = (clientId: string, metadata: ClientMetadata, lifetime: number) => {
    cache.delete(clientId);
    if (cache.size >= CACHED_DOCUMENTS) {
      const [oldest] = cache.keys();
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(clientId, { expiresAt: now() + lifetime, metadata });
  };

  return async (clientId) => {
    const cached = cache.get(clientId);
    if (cached !== undefined && now() < cached.expiresAt) {
      return cached.metadata;
    }
    cache.delete(clientId);
    if (!isClientIdMetadataUrl(clientId)) {
      return undefined;
    }
    const label = loggable(clientLabel(clientId));
    if (budget.wait('all') > 0) {
      log.warn(
        `Did not fetch the client metadata document of ${label}: ${String(FETCHES_PER_MINUTE)} fetches in the last minute.`,
      );
      return undefined;
    }
    budget.record('all');
    try {
      const { lifetime, metadata } = await fetchAndValidate(clientId);
      remember(clientId, metadata, lifetime);
      return metadata;
    } catch (error) {
      const reason = error instanceof FetchFailureError ? error.message : String(error);
      log.warn(`Could not use the client metadata document of ${label}: ${loggable(reason)}.`);
      return undefined;
    }
  };
};
