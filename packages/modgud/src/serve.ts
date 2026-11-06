import { once } from 'node:events';

import { Command } from '@loomcli/core';

import { configOption, loadConfig, openConfiguredStore } from './command-config.ts';
import type { Config } from './config.ts';
import { loggable, timestampedLog } from './log.ts';
import { createPublicListener } from './public-listener.ts';
import type { PublicListener } from './public-listener.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// How long the Public listener lets a connection sit silent, in seconds. The
// MCP transport writes an SSE keep-alive every 15 seconds, so an open stream
// is never cut off.
const CONNECTION_IDLE_SECONDS = 60;

// Starts the Public listener, or fails with a message naming its address.
const listen = (
  config: Config,
  fetch: PublicListener['fetch'],
  fail: (message: string) => never,
) => {
  try {
    return Bun.serve({
      fetch,
      hostname: config.public.host,
      idleTimeout: CONNECTION_IDLE_SECONDS,
      port: config.public.port,
    });
  } catch (error) {
    return fail(
      `Could not listen on ${config.public.host}:${String(config.public.port)}: ${describeError(error)}`,
    );
  }
};

// `modgud serve`: opens the OAuth store and serves every configured Service,
// with the OAuth endpoints, on the Public listener until systemd or a
// terminal stops it, then ends every Session, stops every Child, and closes
// the store. Its runtime lines start with their time.
export const serve = new Command('serve', {
  description: 'Serve the configured Services over Streamable HTTP on the Public listener.',
})
  .option('config', configOption)
  .action(async ({ host, options, out, signal }) => {
    const log = timestampedLog((line) => out.print(line));
    const config = await loadConfig(host, options.config, out);
    const store = await openConfiguredStore(config, host, out);
    const listener = createPublicListener({ config, log, parentEnvironment: host.env, store });
    const server = listen(config, listener.fetch, (message) => {
      // No Session is open yet, so closing only stops the listener's timers.
      void listener.close();
      store.close();
      return out.fatal(loggable(message));
    });
    try {
      const services = Object.keys(config.services).map((name) => `/${name}/mcp`);
      log.info(`Listening on ${server.url.href} for ${services.join(', ')}.`);
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      await listener.close();
      await server.stop(true);
      store.close();
      log.info('Stopped.');
    }
  });
