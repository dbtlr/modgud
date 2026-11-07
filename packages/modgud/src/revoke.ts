import { Command } from '@loomcli/core';

import { configOption, loadConfig, openConfiguredStore } from './command-config.ts';

// `modgud revoke`: revokes every chat-client connection approved so far, with
// every token issued from it, and every unspent Pairing code. Registrations
// stay. The server sees the change on its next read of the store.
export const revoke = new Command('revoke', {
  description: 'Revoke every approved chat-client connection and unspent Pairing code.',
})
  .option('config', configOption)
  .action(async ({ host, log, options, out }) => {
    const config = await loadConfig(host, options.config, { log, out });
    const store = await openConfiguredStore(config, host, { log, out });
    try {
      const revoked = store.revokeAll();
      await out.print(`Revoked ${String(revoked)} authorization${revoked === 1 ? '' : 's'}.`);
    } finally {
      store.close();
    }
  });
