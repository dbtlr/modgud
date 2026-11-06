import { describe, expect, test } from 'bun:test';

import {
  clientLabel,
  isClientIdMetadataUrl,
  matchRedirectUri,
  parseClientMetadata,
  parseMetadataDocument,
} from './client-metadata.ts';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('client metadata', () => {
  test('accepts redirect URIs and a client name, ignoring every other field', () => {
    expect(
      parseClientMetadata({
        client_name: 'Claude',
        client_secret: 'ignored',
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT, 'http://127.0.0.1:33418/callback'],
        response_types: ['code'],
        scope: 'anything',
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    ).toEqual({
      clientName: 'Claude',
      ok: true,
      redirectUris: [REDIRECT, 'http://127.0.0.1:33418/callback'],
    });
  });

  test('leaves out an absent client name', () => {
    expect(parseClientMetadata({ redirect_uris: [REDIRECT] })).toEqual({
      ok: true,
      redirectUris: [REDIRECT],
    });
  });

  test.each([
    ['https with a domain name', 'https://example.com/cb'],
    ['https with a port and query', 'https://app.example.com:8443/cb?x=1'],
    ['http on 127.0.0.1', 'http://127.0.0.1/cb'],
    ['http on [::1] with a port', 'http://[::1]:9000/cb'],
    ['http on localhost', 'http://localhost:3000/callback'],
  ])('accepts a redirect URI: %s', (_, uri) => {
    expect(parseClientMetadata({ redirect_uris: [uri] }).ok).toBe(true);
  });

  test.each([
    ['https on an IPv4 address', 'https://192.0.2.1/cb'],
    ['https on an IPv6 address', 'https://[2001:db8::1]/cb'],
    ['https on an IPv4 address in another notation', 'https://0x7f000001/cb'],
    ['http on a domain name', 'http://example.com/cb'],
    ['http on another loopback address', 'http://127.0.0.2/cb'],
    ['another scheme', 'claude://callback'],
    ['a relative URI', '/callback'],
    ['a fragment', 'https://example.com/cb#x'],
    ['an empty fragment', 'https://example.com/cb#'],
    ['userinfo', 'https://user@example.com/cb'],
    ['empty userinfo', 'https://@example.com/cb'],
    ['a space', 'https://example.com/a b'],
    ['a non-ASCII character', 'https://bücher.example/cb'],
    ['a backslash', String.raw`https://example.com\cb`],
    ['more than 2,048 characters', `https://example.com/${'a'.repeat(2029)}`],
  ])('refuses a redirect URI with invalid_redirect_uri: %s', (_, uri) => {
    expect(parseClientMetadata({ redirect_uris: [uri] })).toEqual({
      error: 'invalid_redirect_uri',
      ok: false,
    });
  });

  test('accepts a redirect URI of exactly 2,048 characters', () => {
    const uri = `https://example.com/${'a'.repeat(2028)}`;
    expect(uri).toHaveLength(2048);
    expect(parseClientMetadata({ redirect_uris: [uri] }).ok).toBe(true);
  });

  test.each([
    ['missing', {}],
    ['not a list', { redirect_uris: REDIRECT }],
    ['empty', { redirect_uris: [] }],
    ['more than 10', { redirect_uris: Array.from({ length: 11 }, (_, i) => `${REDIRECT}${i}`) }],
    ['not strings', { redirect_uris: [42] }],
  ])('refuses redirect_uris that are %s', (_, metadata) => {
    expect(parseClientMetadata(metadata)).toEqual({ error: 'invalid_redirect_uri', ok: false });
  });

  test('accepts 10 redirect URIs', () => {
    const uris = Array.from({ length: 10 }, (_, i) => `${REDIRECT}${i}`);
    expect(parseClientMetadata({ redirect_uris: uris }).ok).toBe(true);
  });

  test.each([
    ['not an object', [REDIRECT]],
    ['null', null],
    ['a client name over 100 characters', { client_name: 'x'.repeat(101) }],
    ['a client name that is not a string', { client_name: 7 }],
    ['grant_types without authorization_code', { grant_types: ['refresh_token'] }],
    ['grant_types that is not a list', { grant_types: 'authorization_code' }],
    ['response_types without code', { response_types: ['token'] }],
    ['response_types that is not a list', { response_types: 'code' }],
  ])('refuses metadata with invalid_client_metadata: %s', (_, metadata) => {
    const body =
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
        ? { redirect_uris: [REDIRECT], ...metadata }
        : metadata;
    expect(parseClientMetadata(body)).toEqual({ error: 'invalid_client_metadata', ok: false });
  });

  test('accepts a client name of 100 characters, counted by code point', () => {
    expect(
      parseClientMetadata({ client_name: '🦊'.repeat(100), redirect_uris: [REDIRECT] }).ok,
    ).toBe(true);
  });
});

describe('client ID metadata URLs', () => {
  test.each([
    'https://claude.ai/oauth/mcp-oauth-client-metadata',
    'https://chatgpt.com/client.json',
  ])('accepts %s', (url) => {
    expect(isClientIdMetadataUrl(url)).toBe(true);
  });

  test.each([
    ['a registered client identifier', 'dGhpcyBpcyBub3QgYSBVUkwgYXQgYWxsLCBqdXN0IGFuIGlk'],
    ['http', 'http://claude.ai/client.json'],
    ['another port', 'https://claude.ai:8443/client.json'],
    ['the root path', 'https://claude.ai/'],
    ['userinfo', 'https://user@claude.ai/client.json'],
    ['a query', 'https://claude.ai/client.json?x=1'],
    ['a fragment', 'https://claude.ai/client.json#x'],
    ['a dot segment', 'https://claude.ai/a/../client.json'],
    ['an encoded dot segment', 'https://claude.ai/a/%2e%2e/client.json'],
  ])('refuses one with %s', (_, url) => {
    expect(isClientIdMetadataUrl(url)).toBe(false);
  });
});

describe('a client in the log', () => {
  test('is a metadata document by its host, and a registered client by a short prefix', () => {
    expect(clientLabel('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('claude.ai');
    expect(clientLabel('dGhpcyBpcyBub3QgYSBVUkwgYXQgYWxsLCBqdXN0IGFuIGlk')).toBe('dGhpcyBp');
  });
});

describe('a client ID metadata document', () => {
  const URL_ID = 'https://chatgpt.com/oauth/client.json';
  const document = (fields: Record<string, unknown> = {}) => ({
    client_id: URL_ID,
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    ...fields,
  });

  test('gives the client name and redirect URIs of a valid document', () => {
    expect(parseMetadataDocument(URL_ID, document())).toEqual({
      clientName: 'ChatGPT',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    });
  });

  test.each([
    [
      'a list of methods that includes none',
      { token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] },
    ],
    [
      'the list, which overrides a singular method',
      {
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'],
      },
    ],
    ['a singular method of none', { token_endpoint_auth_method: 'none' }],
    ['no method at all', {}],
  ])('accepts a public client stated by %s', (_, fields) => {
    expect(parseMetadataDocument(URL_ID, document(fields))).toBeDefined();
  });

  test.each([
    ['not an object', [URL_ID]],
    ['no client_id', document({ client_id: undefined })],
    ['a client_id other than its URL', document({ client_id: 'https://chatgpt.com/other.json' })],
    [
      'a client_id that differs only in case',
      document({ client_id: 'https://ChatGPT.com/oauth/client.json' }),
    ],
    ['a client_secret', document({ client_secret: 'shh' })],
    ['an empty client_secret', document({ client_secret: '' })],
    [
      'a list of methods without none',
      document({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }),
    ],
    [
      'a list of methods that is not a list',
      document({ token_endpoint_auth_methods_supported: 'none' }),
    ],
    [
      'a singular method other than none',
      document({ token_endpoint_auth_method: 'client_secret_basic' }),
    ],
    ['no redirect URIs', document({ redirect_uris: [] })],
    ['an invalid redirect URI', document({ redirect_uris: ['http://chatgpt.com/cb'] })],
    ['a client name over 100 characters', document({ client_name: 'x'.repeat(101) })],
  ])('refuses a document with %s', (_, value) => {
    expect(parseMetadataDocument(URL_ID, value)).toBeUndefined();
  });
});

describe('redirect URI matching', () => {
  const REGISTERED = [REDIRECT, 'http://127.0.0.1:33418/callback', 'http://localhost/cb?x=1'];

  test('matches a requested redirect URI by exact string comparison', () => {
    expect(matchRedirectUri(REGISTERED, REDIRECT)).toBe(REDIRECT);
    expect(matchRedirectUri(REGISTERED, `${REDIRECT}/`)).toBeUndefined();
    expect(matchRedirectUri(REGISTERED, 'https://Claude.ai/api/mcp/auth_callback')).toBeUndefined();
    expect(
      matchRedirectUri(REGISTERED, 'https://claude.ai:443/api/mcp/auth_callback'),
    ).toBeUndefined();
  });

  test('matches a loopback redirect URI that differs only in its port, keeping the requested port', () => {
    expect(matchRedirectUri(REGISTERED, 'http://127.0.0.1:50123/callback')).toBe(
      'http://127.0.0.1:50123/callback',
    );
    expect(matchRedirectUri(REGISTERED, 'http://127.0.0.1/callback')).toBe(
      'http://127.0.0.1/callback',
    );
    expect(matchRedirectUri(REGISTERED, 'http://localhost:8080/cb?x=1')).toBe(
      'http://localhost:8080/cb?x=1',
    );
  });

  test.each([
    ['another path', 'http://127.0.0.1:50123/other'],
    ['another loopback host', 'http://localhost:33418/callback'],
    ['another query', 'http://localhost:8080/cb?x=2'],
    ['https instead of http', 'https://127.0.0.1:33418/callback'],
    ['an invalid port', 'http://127.0.0.1:99999/callback'],
    ['userinfo', 'http://user@127.0.0.1:33418/callback'],
  ])('refuses a loopback redirect URI with %s', (_, uri) => {
    expect(matchRedirectUri(REGISTERED, uri)).toBeUndefined();
  });

  test('uses the one registered redirect URI when the request names none', () => {
    expect(matchRedirectUri([REDIRECT], undefined)).toBe(REDIRECT);
    expect(matchRedirectUri(REGISTERED, undefined)).toBeUndefined();
  });

  test('does not apply the port exception to https', () => {
    expect(
      matchRedirectUri(['https://app.example.com:8443/cb'], 'https://app.example.com:9443/cb'),
    ).toBeUndefined();
  });
});
