// Races one store operation across processes. store.test.ts runs several at
// once, each with the same arguments:
//
//   store-race.ts <path> <startAt> open
//   store-race.ts <path> <startAt> approve <clientId> <pairingCode>
//   store-race.ts <path> <startAt> exchange <clientId> <authorizationCode>
//   store-race.ts <path> <startAt> refresh <clientId> <refreshToken>
//
// Each waits until the clock reaches `startAt`, then runs the operation and
// prints its outcome: `opened`, `approved` or `refused`, or `issued` or the
// token error. `open` waits before opening, so it races the schema migration;
// the others open first and race the operation.
import { s256Challenge } from '../pkce.ts';
import { openStore } from '../store.ts';
import type { TokenResult } from '../store.ts';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const [path = '', startAt = '0', action = '', clientId = '', secret = ''] = process.argv.slice(2);

const waitForStart = () => {
  while (Date.now() < Number(startAt)) {
    // Spin rather than sleep, so every racer starts within the same millisecond.
  }
};

const open = async () =>
  openStore({
    maxTokenLifetimeDays: 30,
    path,
    resource: 'https://modgud.example.com/norn/mcp',
    warn: (message) => console.error(message),
  });

const outcome = (result: TokenResult) => (result.ok ? 'issued' : result.error);

if (action === 'open') {
  waitForStart();
  const store = await open();
  store.close();
  console.log('opened');
} else {
  const store = await open();
  waitForStart();
  if (action === 'approve') {
    const approved = store.approve({
      clientId,
      codeChallenge: s256Challenge(VERIFIER),
      pairingCode: secret,
      redirectUri: REDIRECT,
      requestedRedirectUri: null,
    });
    console.log(approved === undefined ? 'refused' : 'approved');
  } else if (action === 'exchange') {
    console.log(
      outcome(store.exchangeAuthorizationCode({ clientId, code: secret, codeVerifier: VERIFIER })),
    );
  } else if (action === 'refresh') {
    console.log(outcome(store.refresh({ clientId, refreshToken: secret })));
  } else {
    console.error(`Unknown action ${action}.`);
  }
  store.close();
}
