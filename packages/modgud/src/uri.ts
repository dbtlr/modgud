// URI helpers that client metadata, the Approval page, and the metadata
// document fetcher share.

// Hosts an `http` redirect URI may name (RFC 8252 loopback redirects), as the
// URL parser writes them.
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

// A URL's hostname without the brackets the URL parser keeps around an IPv6
// address, as DNS, `isIP`, and TLS expect it.
export const unbracketed = (hostname: string) => hostname.replace(/^\[(.*)\]$/u, '$1');
