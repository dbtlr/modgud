import { Application } from '@loomcli/core';
import { version } from '@loomcli/plugins/version';

import packageJson from '../package.json' with { type: 'json' };

// Loom requires a root action even while the scaffold has no commands.
export const app = new Application('modgud', {
  plugins: [version()],
  version: packageJson.version,
}).action(() => undefined);
