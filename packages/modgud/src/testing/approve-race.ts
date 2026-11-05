// Opens the store at argv[2] and, once the clock reaches argv[5], approves the
// client argv[3] with the Pairing code argv[4]. Prints `approved` or `refused`.
// store.test.ts runs several at once to race one code across processes.
import { s256Challenge } from '../pkce.ts';
import { openStore } from '../store.ts';

const [path = '', clientId = '', pairingCode = '', startAt = '0'] = process.argv.slice(2);

const store = await openStore({
  maxTokenLifetimeDays: 30,
  path,
  resource: 'https://modgud.example.com/norn/mcp',
  warn: (message) => console.error(message),
});
while (Date.now() < Number(startAt)) {
  // Spin rather than sleep, so every racer starts within the same millisecond.
}
const approved = store.approve({
  clientId,
  codeChallenge: s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
  pairingCode,
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  requestedRedirectUri: null,
});
store.close();
console.log(approved === undefined ? 'refused' : 'approved');
