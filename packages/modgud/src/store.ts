import { Database, SQLiteError } from 'bun:sqlite';

import { z } from 'zod';

import { sha256Hex } from './bearer.ts';
import { mintPairingCode, normalizePairingCode } from './pairing-code.ts';
import { s256Challenge } from './pkce.ts';
import { randomIdentifier } from './secrets.ts';
import { secureStoreFiles } from './store-files.ts';

// The OAuth server's store (docs/oauth.md, "Store" and "Tokens and
// authorizations"): registrations, unspent Pairing codes, authorizations,
// authorization codes, and access tokens in one SQLite database that the
// server and the `pair` and `revoke` commands share. Every secret is kept only
// as its SHA-256 hash, and every single-use step runs in one `BEGIN IMMEDIATE`
// transaction, so it succeeds at most once even across processes.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const AUTHORIZATION_CODE_LIFETIME = 60 * SECOND;
const ACCESS_TOKEN_LIFETIME = HOUR;
const ACCESS_TOKENS_KEPT = 5;
const UNAPPROVED_CLIENT_LIFETIME = HOUR;
const STORED_CLIENTS = 500;
// How long a busy store makes a writer wait for another process's transaction.
const BUSY_TIMEOUT_MS = 5000;

const ACCESS_TOKEN_PREFIX = 'mdg_at_';
// `mdg_rt_<family>.<secret>`, each part 32 bytes in base64url: 94 characters.
const REFRESH_TOKEN = /^mdg_rt_([A-Za-z0-9_-]{43})\.[A-Za-z0-9_-]{43}$/u;

const SCHEMA_VERSION = 1;
const SCHEMA = `
  CREATE TABLE clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    approved_at INTEGER
  ) STRICT;
  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE authorizations (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    refresh_family TEXT NOT NULL UNIQUE,
    refresh_hash TEXT
  ) STRICT;
  CREATE TABLE authorization_codes (
    code_hash TEXT PRIMARY KEY,
    authorization_id TEXT NOT NULL REFERENCES authorizations (id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    requested_redirect_uri TEXT,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    spent_at INTEGER
  ) STRICT;
  CREATE INDEX authorization_codes_by_authorization ON authorization_codes (authorization_id);
  CREATE TABLE access_tokens (
    token_hash TEXT PRIMARY KEY,
    authorization_id TEXT NOT NULL REFERENCES authorizations (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX access_tokens_by_authorization ON access_tokens (authorization_id);
`;

export type StoreOptions = {
  path: string;
  // Receives a warning when a store file's mode was wider than 0600.
  warn: (message: string) => void;
  // `harness.max_token_lifetime_days`, applied to every authorization when it
  // is checked, not when it was approved.
  maxTokenLifetimeDays: number;
  // The harness Service's resource URI. Approvals are for it, and an
  // authorization for any other resource is no longer valid.
  resource: string;
  // Milliseconds since the epoch.
  now?: () => number;
  // How many registrations the store keeps: 500, or fewer in tests.
  storedClients?: number;
};

export type RegisteredClient = {
  clientId: string;
  // Seconds since the epoch, as RFC 7591 states it.
  clientIdIssuedAt: number;
  clientName?: string;
  redirectUris: string[];
};

export type Approval = {
  // The Pairing code as the person entered it.
  pairingCode: string;
  clientId: string;
  // The redirect URI the authorization code is sent to.
  redirectUri: string;
  // The `redirect_uri` the authorization request carried, or null when it
  // carried none. The token request must repeat it when it is not null.
  requestedRedirectUri: string | null;
  codeChallenge: string;
};

export type IssuedTokens = {
  accessToken: string;
  authorizationId: string;
  // Seconds until the access token expires: 1 hour, or less when the
  // authorization expires sooner.
  expiresIn: number;
  refreshToken: string;
};

// The outcome of a token request. `revokedAuthorizationId` names the
// authorization a replayed code or refresh token revoked, for the log.
export type TokenResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; error: 'invalid_grant' }
  | { ok: false; error: 'invalid_grant'; revokedAuthorizationId: string }
  | { ok: false; error: 'invalid_target' };

export type CodeExchange = {
  code: string;
  clientId: string;
  codeVerifier: string;
  redirectUri?: string | undefined;
  resource?: string | undefined;
};

export type Refresh = {
  refreshToken: string;
  clientId: string;
  resource?: string | undefined;
};

// What a valid access token grants.
export type AccessGrant = { authorizationId: string; clientId: string; resource: string };

export type Store = {
  // Stores a dynamic registration. Past 500 it evicts the oldest registration
  // with no live authorization, never-approved ones first; when every stored
  // registration has a live authorization, it stores nothing and returns
  // undefined.
  registerClient: (registration: {
    clientName?: string | undefined;
    redirectUris: string[];
  }) => RegisteredClient | undefined;
  // A stored registration, or undefined when it is unknown or was never approved within 1 hour.
  findClient: (clientId: string) => RegisteredClient | undefined;
  // Mints a Pairing code that lasts the given minutes; only its hash is stored.
  mintPairingCode: (minutes: number) => { code: string; expiresAt: Date };
  // Spends the Pairing code, creates the authorization, and issues its
  // authorization code in one transaction. Undefined when the code is wrong,
  // expired, or spent.
  approve: (approval: Approval) => { authorizationId: string; code: string } | undefined;
  // Spends an authorization code for tokens. A spent code revokes its authorization.
  exchangeAuthorizationCode: (exchange: CodeExchange) => TokenResult;
  // Rotates a refresh token. A non-current token of the family, with the
  // family's client, revokes the authorization.
  refresh: (refresh: Refresh) => TokenResult;
  // What an access token grants, or undefined when it is not valid now.
  verifyAccessToken: (accessToken: string) => AccessGrant | undefined;
  // Whether the authorization exists, has not expired, and is for the harness Service.
  isAuthorizationActive: (authorizationId: string) => boolean;
  // Deletes every authorization, with its codes and tokens, and every unspent
  // Pairing code. Returns how many authorizations it deleted.
  revokeAll: () => number;
  // Deletes expired rows. The server calls it at least hourly.
  removeExpired: () => void;
  close: () => void;
};

type ClientRow = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
  created_at: number;
};

type AuthorizationRow = {
  id: string;
  client_id: string;
  resource: string;
  approved_at: number;
  refresh_family: string;
  refresh_hash: string | null;
};

type CodeRow = AuthorizationRow & {
  authorization_id: string;
  code_client_id: string;
  requested_redirect_uri: string | null;
  code_challenge: string;
  expires_at: number;
  spent_at: number | null;
};

const toClient = (row: ClientRow): RegisteredClient => ({
  clientId: row.client_id,
  clientIdIssuedAt: Math.floor(row.created_at / SECOND),
  ...(row.client_name === null ? {} : { clientName: row.client_name }),
  redirectUris: z.array(z.string()).parse(JSON.parse(row.redirect_uris)),
});

// Creates the schema in a new database, and refuses one a newer Modgud wrote.
// The version is read inside the write transaction, so when several
// processes open a new store at once, only the first creates the schema.
const migrate = (db: Database, path: string) => {
  db.transaction(() => {
    const version =
      db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
    if (version === SCHEMA_VERSION) {
      return;
    }
    if (version !== 0) {
      throw new Error(
        `The store ${path} has schema version ${String(version)}, which this Modgud does not know.`,
      );
    }
    db.run(SCHEMA);
    db.run(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
  }).immediate();
};

// Switches the database to write-ahead logging, which lasts once set. While
// another process opening a new store is switching it too, SQLite answers
// busy at once rather than waiting out the busy timeout, so this retries.
const useWriteAheadLog = async (db: Database) => {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.run('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (
        !(error instanceof SQLiteError) ||
        error.code !== 'SQLITE_BUSY' ||
        Date.now() > deadline
      ) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- each retry waits for the other process
    await Bun.sleep(10);
  }
};

// Opens the store at `options.path`, checking its directory and file modes
// first. Rejects with an Error naming the path when it cannot.
export const openStore = async (options: StoreOptions): Promise<Store> => {
  const { path, warn, resource } = options;
  const now = options.now ?? Date.now;
  const storedClients = options.storedClients ?? STORED_CLIENTS;
  const lifetime = options.maxTokenLifetimeDays * DAY;

  await secureStoreFiles(path, warn);
  const db = new Database(path, { create: true, strict: true });
  db.run(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  await useWriteAheadLog(db);
  db.run('PRAGMA foreign_keys = ON');
  migrate(db, path);
  // WAL mode adds the -wal and -shm files, which take the database's mode.
  await secureStoreFiles(path, warn);

  const isActive = (authorization: Pick<AuthorizationRow, 'approved_at' | 'resource'>) =>
    authorization.resource === resource && now() < authorization.approved_at + lifetime;

  const findAuthorization = db.query<AuthorizationRow, { id: string }>(
    'SELECT * FROM authorizations WHERE id = $id',
  );
  const deleteAuthorization = db.query<unknown, { id: string }>(
    'DELETE FROM authorizations WHERE id = $id',
  );
  const insertAccessToken = db.query<
    unknown,
    { token_hash: string; authorization_id: string; expires_at: number }
  >(
    'INSERT INTO access_tokens (token_hash, authorization_id, expires_at) VALUES ($token_hash, $authorization_id, $expires_at)',
  );
  // Rowids only grow, so the highest are the newest.
  const trimAccessTokens = db.query<unknown, { authorization_id: string; kept: number }>(
    `DELETE FROM access_tokens WHERE authorization_id = $authorization_id AND rowid NOT IN (
       SELECT rowid FROM access_tokens WHERE authorization_id = $authorization_id
       ORDER BY rowid DESC LIMIT $kept
     )`,
  );
  const setRefreshHash = db.query<unknown, { id: string; refresh_hash: string }>(
    'UPDATE authorizations SET refresh_hash = $refresh_hash WHERE id = $id',
  );

  // Issues an access token and the authorization's next refresh token, which
  // replaces the current one. Runs inside the caller's transaction.
  const issueTokens = (authorization: AuthorizationRow): TokenResult => {
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomIdentifier()}`;
    const refreshToken = `mdg_rt_${authorization.refresh_family}.${randomIdentifier()}`;
    const issuedAt = now();
    const expiresAt = Math.min(
      issuedAt + ACCESS_TOKEN_LIFETIME,
      authorization.approved_at + lifetime,
    );
    setRefreshHash.run({ id: authorization.id, refresh_hash: sha256Hex(refreshToken) });
    insertAccessToken.run({
      authorization_id: authorization.id,
      expires_at: expiresAt,
      token_hash: sha256Hex(accessToken),
    });
    trimAccessTokens.run({ authorization_id: authorization.id, kept: ACCESS_TOKENS_KEPT });
    return {
      ok: true,
      tokens: {
        accessToken,
        authorizationId: authorization.id,
        expiresIn: Math.floor((expiresAt - issuedAt) / SECOND),
        refreshToken,
      },
    };
  };

  const revokeForReplay = (authorizationId: string): TokenResult => {
    deleteAuthorization.run({ id: authorizationId });
    return { error: 'invalid_grant', ok: false, revokedAuthorizationId: authorizationId };
  };

  // The registrations the cap may evict, in the order it evicts them: those
  // with no live authorization, never-approved ones first, then oldest first.
  const evictableClients = db.query<
    { client_id: string },
    { resource: string; expired_before: number; limit: number }
  >(
    `SELECT client_id FROM clients c
      WHERE NOT EXISTS (
        SELECT 1 FROM authorizations a
         WHERE a.client_id = c.client_id AND a.resource = $resource AND a.approved_at > $expired_before
      )
      ORDER BY approved_at IS NOT NULL, created_at, rowid
      LIMIT $limit`,
  );

  const registerClient: Store['registerClient'] = ({ clientName, redirectUris }) =>
    db
      .transaction((): RegisteredClient | undefined => {
        const { stored } = db
          .query<{ stored: number }, []>('SELECT count(*) AS stored FROM clients')
          .get() ?? { stored: 0 };
        const excess = stored - storedClients + 1;
        if (excess > 0) {
          const evicted = evictableClients.all({
            expired_before: now() - lifetime,
            limit: excess,
            resource,
          });
          if (evicted.length < excess) {
            return undefined;
          }
          for (const { client_id: clientId } of evicted) {
            db.query('DELETE FROM clients WHERE client_id = $client_id').run({
              client_id: clientId,
            });
          }
        }
        const row: ClientRow = {
          client_id: randomIdentifier(),
          client_name: clientName ?? null,
          created_at: now(),
          redirect_uris: JSON.stringify(redirectUris),
        };
        db.query(
          'INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES ($client_id, $client_name, $redirect_uris, $created_at)',
        ).run(row);
        return toClient(row);
      })
      .immediate();

  const findClient: Store['findClient'] = (clientId) => {
    const row = db
      .query<ClientRow, { client_id: string; forgotten_before: number }>(
        `SELECT * FROM clients WHERE client_id = $client_id
           AND (approved_at IS NOT NULL OR created_at > $forgotten_before)`,
      )
      .get({ client_id: clientId, forgotten_before: now() - UNAPPROVED_CLIENT_LIFETIME });
    return row === null ? undefined : toClient(row);
  };

  const mintCode: Store['mintPairingCode'] = (minutes) => {
    const code = mintPairingCode();
    const expiresAt = now() + minutes * MINUTE;
    db.query(
      'INSERT INTO pairing_codes (code_hash, expires_at) VALUES ($code_hash, $expires_at)',
    ).run({ code_hash: sha256Hex(normalizePairingCode(code) ?? code), expires_at: expiresAt });
    return { code, expiresAt: new Date(expiresAt) };
  };

  const approve: Store['approve'] = (approval) => {
    const pairingCode = normalizePairingCode(approval.pairingCode);
    if (pairingCode === undefined) {
      return undefined;
    }
    return db
      .transaction(() => {
        const approvedAt = now();
        const spent = db
          .query('DELETE FROM pairing_codes WHERE code_hash = $code_hash AND expires_at > $now')
          .run({ code_hash: sha256Hex(pairingCode), now: approvedAt });
        if (spent.changes !== 1) {
          return undefined;
        }
        const authorizationId = randomIdentifier();
        db.query(
          `INSERT INTO authorizations (id, client_id, redirect_uri, resource, approved_at, refresh_family)
           VALUES ($id, $client_id, $redirect_uri, $resource, $approved_at, $refresh_family)`,
        ).run({
          approved_at: approvedAt,
          client_id: approval.clientId,
          id: authorizationId,
          redirect_uri: approval.redirectUri,
          refresh_family: randomIdentifier(),
          resource,
        });
        db.query(
          'UPDATE clients SET approved_at = $now WHERE client_id = $client_id AND approved_at IS NULL',
        ).run({ client_id: approval.clientId, now: approvedAt });
        const code = randomIdentifier();
        db.query(
          `INSERT INTO authorization_codes
             (code_hash, authorization_id, client_id, requested_redirect_uri, code_challenge, expires_at)
           VALUES ($code_hash, $authorization_id, $client_id, $requested_redirect_uri, $code_challenge, $expires_at)`,
        ).run({
          authorization_id: authorizationId,
          client_id: approval.clientId,
          code_challenge: approval.codeChallenge,
          code_hash: sha256Hex(code),
          expires_at: approvedAt + AUTHORIZATION_CODE_LIFETIME,
          requested_redirect_uri: approval.requestedRedirectUri,
        });
        return { authorizationId, code };
      })
      .immediate();
  };

  const exchangeAuthorizationCode: Store['exchangeAuthorizationCode'] = (exchange) =>
    db
      .transaction((): TokenResult => {
        const row = db
          .query<CodeRow, { code_hash: string }>(
            `SELECT a.*, c.authorization_id, c.client_id AS code_client_id, c.requested_redirect_uri,
                    c.code_challenge, c.expires_at, c.spent_at
               FROM authorization_codes c JOIN authorizations a ON a.id = c.authorization_id
              WHERE c.code_hash = $code_hash`,
          )
          .get({ code_hash: sha256Hex(exchange.code) });
        if (row === null) {
          return { error: 'invalid_grant', ok: false };
        }
        if (row.spent_at !== null) {
          return revokeForReplay(row.authorization_id);
        }
        if (
          now() >= row.expires_at ||
          exchange.clientId !== row.code_client_id ||
          (row.requested_redirect_uri !== null &&
            exchange.redirectUri !== row.requested_redirect_uri) ||
          s256Challenge(exchange.codeVerifier) !== row.code_challenge
        ) {
          return { error: 'invalid_grant', ok: false };
        }
        if (exchange.resource !== undefined && exchange.resource !== row.resource) {
          return { error: 'invalid_target', ok: false };
        }
        if (!isActive(row)) {
          return { error: 'invalid_grant', ok: false };
        }
        db.query('UPDATE authorization_codes SET spent_at = $now WHERE code_hash = $code_hash').run(
          { code_hash: sha256Hex(exchange.code), now: now() },
        );
        return issueTokens(row);
      })
      .immediate();

  const refresh: Store['refresh'] = (request) => {
    const family = REFRESH_TOKEN.exec(request.refreshToken)?.[1];
    if (family === undefined) {
      return { error: 'invalid_grant', ok: false };
    }
    return db
      .transaction((): TokenResult => {
        const authorization = db
          .query<AuthorizationRow, { family: string }>(
            'SELECT * FROM authorizations WHERE refresh_family = $family',
          )
          .get({ family });
        // Only the family's own client can trigger a replay revocation, so a
        // token sent with another client_id is refused and changes nothing.
        if (authorization === null || authorization.client_id !== request.clientId) {
          return { error: 'invalid_grant', ok: false };
        }
        if (authorization.refresh_hash !== sha256Hex(request.refreshToken)) {
          return revokeForReplay(authorization.id);
        }
        if (!isActive(authorization)) {
          return { error: 'invalid_grant', ok: false };
        }
        if (request.resource !== undefined && request.resource !== authorization.resource) {
          return { error: 'invalid_target', ok: false };
        }
        return issueTokens(authorization);
      })
      .immediate();
  };

  const verifyAccessToken: Store['verifyAccessToken'] = (accessToken) => {
    if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) {
      return undefined;
    }
    const row = db
      .query<AuthorizationRow & { expires_at: number }, { token_hash: string }>(
        `SELECT a.*, t.expires_at FROM access_tokens t JOIN authorizations a ON a.id = t.authorization_id
          WHERE t.token_hash = $token_hash`,
      )
      .get({ token_hash: sha256Hex(accessToken) });
    if (row === null || now() >= row.expires_at || !isActive(row)) {
      return undefined;
    }
    return { authorizationId: row.id, clientId: row.client_id, resource: row.resource };
  };

  const isAuthorizationActive: Store['isAuthorizationActive'] = (authorizationId) => {
    const authorization = findAuthorization.get({ id: authorizationId });
    return authorization !== null && isActive(authorization);
  };

  const revokeAll: Store['revokeAll'] = () =>
    db
      .transaction(() => {
        // Bun's change count includes the rows the cascade deletes, so count first.
        const { revoked } = db
          .query<{ revoked: number }, []>('SELECT count(*) AS revoked FROM authorizations')
          .get() ?? { revoked: 0 };
        db.run('DELETE FROM pairing_codes');
        db.run('DELETE FROM authorizations');
        return revoked;
      })
      .immediate();

  // A spent authorization code stays with its authorization, so presenting it
  // again is recognized as a replay for as long as the authorization lives.
  const removeExpired: Store['removeExpired'] = () => {
    const at = now();
    db.transaction(() => {
      db.query('DELETE FROM pairing_codes WHERE expires_at <= $at').run({ at });
      db.query('DELETE FROM authorizations WHERE approved_at <= $expired_before').run({
        expired_before: at - lifetime,
      });
      db.query('DELETE FROM authorization_codes WHERE spent_at IS NULL AND expires_at <= $at').run({
        at,
      });
      db.query('DELETE FROM access_tokens WHERE expires_at <= $at').run({ at });
      db.query(
        'DELETE FROM clients WHERE approved_at IS NULL AND created_at <= $forgotten_before',
      ).run({ forgotten_before: at - UNAPPROVED_CLIENT_LIFETIME });
    }).immediate();
  };

  return {
    approve,
    close: () => db.close(),
    exchangeAuthorizationCode,
    findClient,
    isAuthorizationActive,
    mintPairingCode: mintCode,
    refresh,
    registerClient,
    removeExpired,
    revokeAll,
    verifyAccessToken,
  };
};
