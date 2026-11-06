import { request } from 'node:https';
import { isIP } from 'node:net';

import type { Connect, MetadataResponse } from './metadata-document.ts';
import { unbracketed } from './uri.ts';

// An HTTPS GET to one address that has already passed the address check
// (docs/oauth.md, "Client metadata documents"). The request goes to the
// address itself, an IP literal, so DNS is never consulted again; the TLS
// server name, the certificate check, and `Host` use the URL's host. Node's
// HTTPS client reads no proxy settings from the environment and follows no
// redirects. `port` and `ca` exist for tests: Modgud fetches on 443 with the
// system's trusted certificates.
export const pinnedHttpsConnect =
  ({ ca, port = 443 }: { ca?: string; port?: number } = {}): Connect =>
  async ({ address, signal, url }) => {
    const connected = Promise.withResolvers<MetadataResponse>();
    const hostname = unbracketed(url.hostname);
    const outgoing = request(
      {
        agent: false,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Host: url.host },
        host: address,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        port,
        ...(ca === undefined ? {} : { ca }),
        // A server name is a DNS name; an IP-literal host is checked as itself.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value ?? '']) {
            headers.append(name, item);
          }
        }
        connected.resolve({ body: response, headers, status: response.statusCode ?? 0 });
      },
    );
    const abort = () => {
      outgoing.destroy(new Error('The metadata document request was aborted.'));
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    outgoing.on('error', connected.reject);
    outgoing.end();
    return connected.promise;
  };
