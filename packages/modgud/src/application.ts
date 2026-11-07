import { Application } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { logging } from '@loomcli/plugins/logging';
import { service } from '@loomcli/plugins/service';
import { version } from '@loomcli/plugins/version';

import packageJson from '../package.json' with { type: 'json' };
import { pair } from './pair.ts';
import { revoke } from './revoke.ts';
import { serve } from './serve.ts';

// SIGTERM from systemd and SIGINT from a terminal cancel `serve`, and it gets
// this long to end its Sessions, stop their Children, and stop listening.
// Each Child gets two seconds after SIGTERM, so Loom's 500 ms default is short.
const shutdown = { timeout: 10_000 };

// `modgud service install` runs plain `modgud serve` as a systemd user unit or
// a launchd agent. Loom's logging plugin writes every log event, serve's
// included, to ~/.local/state/modgud/modgud.jsonl (~/Library/Logs/modgud/ on
// macOS).
export const app = new Application('modgud', {
  description: 'Serve local stdio MCP servers over Streamable HTTP, behind its own OAuth server.',
  plugins: [help(), version(), logging(), service({ label: 'com.dbtlr.modgud', run: ['serve'] })],
  shutdown,
  version: packageJson.version,
})
  .command(serve)
  .command(pair)
  .command(revoke);
