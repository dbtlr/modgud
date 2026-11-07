import { Command } from '@loomcli/core';
import { z } from 'zod';

import { configOption, loadConfig, openConfiguredStore } from './command-config.ts';

const DEFAULT_MINUTES = 10;

// `modgud pair`: mints a Pairing code that approves one chat-client
// connection on the Approval page, and prints it with its expiry.
export const pair = new Command('pair', {
  description: 'Mint a Pairing code that approves one chat-client connection.',
})
  .option('config', configOption)
  .option('minutes', {
    default: String(DEFAULT_MINUTES),
    description: 'Minutes until the code expires, from 1 to 60. Defaults to 10.',
    type: 'string',
    validate: z.coerce.number().int().min(1).max(60),
  })
  .action(async ({ host, log, options, out }) => {
    const config = await loadConfig(host, options.config, { log, out });
    const store = await openConfiguredStore(config, host, { log, out });
    try {
      const { code, expiresAt } = store.mintPairingCode(options.minutes);
      const minutes = `${String(options.minutes)} minute${options.minutes === 1 ? '' : 's'}`;
      await out.print(`Pairing code: ${code}`);
      await out.print(`Expires at ${expiresAt.toISOString()}, in ${minutes}.`);
    } finally {
      store.close();
    }
  });
