import { once } from 'node:events';

import { Command } from '@loomcli/core';

import { createAdminListener } from './admin-listener.ts';
import { configOption, loadConfig, openConfiguredStore } from './command-config.ts';
import { loggable, timestampedLog } from './log.ts';
import { createPublicListener } from './public-listener.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// How long the Public listener lets a connection sit silent, in seconds. The
// MCP transport writes an SSE keep-alive every 15 seconds, so an open stream
// is never cut off.
const CONNECTION_IDLE_SECONDS = 60;

// Starts one listener's HTTP server, or fails with a message naming its address.
const listen = (
  {
    fetch,
    host,
    idleTimeout,
    port,
  }: {
    fetch: (request: Request, server: Bun.Server<undefined>) => Promise<Response>;
    host: string;
    idleTimeout?: number;
    port: number;
  },
  fail: (message: string) => never,
) => {
  try {
    return Bun.serve({
      fetch,
      hostname: host,
      port,
      ...(idleTimeout === undefined ? {} : { idleTimeout }),
    });
  } catch (error) {
    return fail(`Could not listen on ${host}:${String(port)}: ${describeError(error)}`);
  }
};

// `modgud serve`: opens the OAuth store, serves every configured Service, with
// the OAuth endpoints, on the Public listener, and the Approval page on the
// Admin listener, until systemd or a terminal stops it. Then it ends every
// Session, stops every Child, stops both listeners, and closes the store. Its
// runtime lines start with their time.
export const serve = new Command('serve', {
  description:
    'Serve the configured Services over Streamable HTTP on the Public listener, and the Approval page on the Admin listener.',
})
  .option('config', configOption)
  .action(async ({ host, options, out, signal }) => {
    const log = timestampedLog((line) => out.print(line));
    const config = await loadConfig(host, options.config, out);
    const store = await openConfiguredStore(config, host, out);
    const publicListener = createPublicListener({
      config,
      log,
      parentEnvironment: host.env,
      store,
    });
    const adminListener = createAdminListener({ config, log, store });
    const publicServer = listen(
      {
        fetch: publicListener.fetch,
        host: config.public.host,
        idleTimeout: CONNECTION_IDLE_SECONDS,
        port: config.public.port,
      },
      (message) => {
        // No Session is open yet, so closing only stops the listener's timers.
        void publicListener.close();
        store.close();
        return out.fatal(loggable(message));
      },
    );
    const adminServer = listen(
      { fetch: adminListener.fetch, host: config.admin.host, port: config.admin.port },
      (message) => {
        void publicListener.close();
        void publicServer.stop(true);
        store.close();
        return out.fatal(loggable(message));
      },
    );
    try {
      const services = Object.keys(config.services).map((name) => `/${name}/mcp`);
      log.info(`Listening on ${publicServer.url.href} for ${services.join(', ')}.`);
      log.info(
        `Listening on ${adminServer.url.href} for the Approval page at ${config.admin.base_url}/authorize.`,
      );
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      await publicListener.close();
      adminListener.close();
      await Promise.all([publicServer.stop(true), adminServer.stop(true)]);
      store.close();
      log.info('Stopped.');
    }
  });
