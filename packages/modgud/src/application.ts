import { Application } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';

import packageJson from '../package.json' with { type: 'json' };
import { serve } from './serve.ts';

// SIGTERM from systemd and SIGINT from a terminal cancel `serve`, and it gets
// this long to end its Sessions, stop their Children, and stop listening.
// Each Child gets two seconds after SIGTERM, so Loom's 500 ms default is short.
const shutdown = { timeout: 10_000 };

export const app = new Application('modgud', {
  plugins: [help(), version()],
  shutdown,
  version: packageJson.version,
}).command(serve);
