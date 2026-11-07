import { once } from 'node:events';

import { Command } from '@loomcli/core';

import { createAdminListener } from './admin-listener.ts';
import { configOption, loadConfig, openConfiguredStore } from './command-config.ts';
import { internalServerError } from './http.ts';
import { describeError, loggable } from './log.ts';
import type { Log } from './log.ts';
import { createPublicListener } from './public-listener.ts';

// How long the Public listener lets a connection sit silent, in seconds. The
// MCP transport writes an SSE keep-alive every 15 seconds, so an open stream
// is never cut off.
const CONNECTION_IDLE_SECONDS = 60;

// How long the Admin listener lets a connection sit silent, in seconds. Its
// slowest answer waits on a metadata fetch of at most 5 seconds.
const ADMIN_IDLE_SECONDS = 30;

// Starts one listener's HTTP server, or fails with a message naming its address.
// Each listener answers its own failures with a plain HTTP 500; Bun's `error`
// handler does the same for anything that escapes, and `development: false`
// keeps Bun's error page, with its stack and paths, out of every answer.
export const listen = (
  {
    fetch,
    host,
    idleTimeout,
    log,
    port,
  }: {
    fetch: (request: Request, server: Bun.Server<undefined>) => Promise<Response>;
    host: string;
    idleTimeout: number;
    log: Log;
    port: number;
  },
  fail: (message: string) => never,
) => {
  try {
    return Bun.serve({
      development: false,
      error: (error) => {
        log.warn(`Answered a request with HTTP 500: ${loggable(describeError(error))}`);
        return internalServerError();
      },
      fetch,
      hostname: host,
      idleTimeout,
      port,
      // Bun lets a second server bind a host and port another already holds,
      // and splits the traffic; refuse it instead (ADR-0004).
      reusePort: false,
    });
  } catch (error) {
    return fail(`Could not listen on ${host}:${String(port)}: ${describeError(error)}`);
  }
};

// `modgud serve`: opens the OAuth store, serves every configured Service, with
// the OAuth endpoints, on the Public listener, and the Approval page on the
// Admin listener, until systemd or a terminal stops it. Then it ends every
// Session, stops every Child, stops both listeners, and closes the store. Its
// runtime events go to Loom's log; where it listens and that it stopped are
// also printed for the person who started it.
export const serve = new Command('serve', {
  description:
    'Serve the configured Services over Streamable HTTP on the Public listener, and the Approval page on the Admin listener.',
})
  .option('config', configOption)
  .action(async ({ host, log, options, out, signal }) => {
    const announce = async (message: string) => {
      log.info(message);
      await out.print(message);
    };
    const config = await loadConfig(host, options.config, { log, out });
    const store = await openConfiguredStore(config, host, { log, out });
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
        log,
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
      {
        fetch: adminListener.fetch,
        host: config.admin.host,
        idleTimeout: ADMIN_IDLE_SECONDS,
        log,
        port: config.admin.port,
      },
      (message) => {
        void publicListener.close();
        void publicServer.stop(true);
        store.close();
        return out.fatal(loggable(message));
      },
    );
    try {
      const services = Object.keys(config.services).map((name) => `/${name}/mcp`);
      await announce(`Listening on ${publicServer.url.href} for ${services.join(', ')}.`);
      await announce(
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
      await announce('Stopped.');
    }
  });
