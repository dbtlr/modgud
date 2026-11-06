import { isIP } from 'node:net';

// The rules a client's metadata follows, whether it arrives as a dynamic
// registration or, later, as a Client ID Metadata Document (docs/oauth.md,
// "Dynamic client registration" and "Client metadata documents").

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;

// Hosts an `http` redirect URI may name (RFC 8252 loopback redirects).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

// A URI is printable ASCII; this also refuses spaces, which the URL parser
// would otherwise strip or encode.
const PRINTABLE_ASCII = /^[!-~]+$/u;

export type ClientMetadata = { clientName?: string; redirectUris: string[] };

export type ClientMetadataResult =
  | ({ ok: true } & ClientMetadata)
  | { ok: false; error: 'invalid_client_metadata' | 'invalid_redirect_uri' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The authority part of an absolute URI as written, before the URL parser
// normalizes it, so empty userinfo such as `https://@host/` still shows.
const writtenAuthority = (uri: string) => /^[a-z]+:\/\/([^/?#]*)/u.exec(uri)?.[1] ?? '';

// Whether the string is an absolute URI of the scheme with no fragment and no
// userinfo, parsed.
const parseUri = (uri: string, scheme: 'http' | 'https'): URL | undefined => {
  if (
    !PRINTABLE_ASCII.test(uri) ||
    uri.includes('\\') ||
    uri.includes('#') ||
    !uri.startsWith(`${scheme}://`) ||
    writtenAuthority(uri).includes('@') ||
    !URL.canParse(uri)
  ) {
    return undefined;
  }
  return new URL(uri);
};

// An `https` URI whose host is a domain name, or an `http` URI on a loopback
// host; at most 2,048 characters, with no fragment or userinfo.
export const isRedirectUri = (uri: string) => {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }
  const secure = parseUri(uri, 'https');
  if (secure !== undefined) {
    return (
      secure.hostname !== '' && !secure.hostname.startsWith('[') && isIP(secure.hostname) === 0
    );
  }
  const loopback = parseUri(uri, 'http');
  return loopback !== undefined && LOOPBACK_HOSTS.has(loopback.hostname);
};

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// A list that is absent, or present and includes the required value.
const allows = (value: unknown, required: string) =>
  value === undefined || (isStringList(value) && value.includes(required));

// Validates RFC 7591 client metadata: `redirect_uris`, `client_name`,
// `grant_types`, and `response_types`. Every other field is ignored.
export const parseClientMetadata = (metadata: unknown): ClientMetadataResult => {
  if (!isRecord(metadata)) {
    return { error: 'invalid_client_metadata', ok: false };
  }
  const { client_name: clientName, redirect_uris: redirectUris } = metadata;
  if (
    !isStringList(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(isRedirectUri)
  ) {
    return { error: 'invalid_redirect_uri', ok: false };
  }
  if (
    (clientName !== undefined &&
      (typeof clientName !== 'string' ||
        // Code points, as a person counts characters.
        // oxlint-disable-next-line typescript/no-misused-spread
        [...clientName].length > MAX_CLIENT_NAME_LENGTH)) ||
    !allows(metadata.grant_types, 'authorization_code') ||
    !allows(metadata.response_types, 'code')
  ) {
    return { error: 'invalid_client_metadata', ok: false };
  }
  return { ok: true, redirectUris, ...(clientName === undefined ? {} : { clientName }) };
};

// Whether a `client_id` names a Client ID Metadata Document: an `https` URL on
// port 443 with a path other than `/` and no userinfo, query, fragment, or dot
// segment. It is compared as a plain string, so it must already be in the
// form the URL parser writes, which also refuses encoded dot segments.
export const isClientIdMetadataUrl = (clientId: string) => {
  const url = parseUri(clientId, 'https');
  return (
    url !== undefined &&
    url.href === clientId &&
    url.port === '' &&
    url.pathname !== '/' &&
    !clientId.includes('?')
  );
};

// A client as the log names it: a metadata document's URL by its host, which
// is public, and a registered client by a short prefix of its identifier.
export const clientLabel = (clientId: string) =>
  isClientIdMetadataUrl(clientId) ? new URL(clientId).host : clientId.slice(0, 8);
