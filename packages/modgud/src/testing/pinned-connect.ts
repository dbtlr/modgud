// Run as a separate process by pinned-https.test.ts: connects through the
// pinned connector to the test server on the port given, and prints the status
// and body as JSON. The test starts it with proxy variables naming a closed
// port, so those variables never touch the test runner's own process.
import { pinnedHttpsConnect } from '../pinned-https.ts';
import { CERTIFICATE, METADATA_HOST } from './metadata-tls.ts';

const port = Number(process.argv[2]);
const response = await pinnedHttpsConnect({ ca: CERTIFICATE, port })({
  address: '127.0.0.1',
  signal: new AbortController().signal,
  url: new URL(`https://${METADATA_HOST}/client.json`),
});
const chunks: Uint8Array[] = [];
for await (const chunk of response.body) {
  chunks.push(chunk);
}
console.log(
  JSON.stringify({ body: Buffer.concat(chunks).toString('utf8'), status: response.status }),
);
