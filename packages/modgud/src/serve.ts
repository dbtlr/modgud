import { once } from 'node:events';
import { resolve } from 'node:path';

import { Command } from '@loomcli/core';

import { defaultConfigPath, readConfig } from './config.ts';
import type { Config } from './config.ts';
import { loggable, timestampedLog } from './log.ts';
import { createPublicListener } from './public-listener.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// How long the Public listener lets a connection sit silent, in seconds. The
// MCP transport writes an SSE keep-alive every 15 seconds, so an open stream
// is never cut off.
const CONNECTION_IDLE_SECONDS = 60;

// Starts the Public listener, or fails with a message naming its address.
const listen = (
  config: Config,
  fetch: (request: Request) => Promise<Response>,
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

// `modgud serve`: serves every configured Service on the Public listener until
// systemd or a terminal stops it, then ends every Session and stops every
// Child. Its runtime lines start with their time.
export const serve = new Command('serve', {
  description: 'Serve the configured Services over Streamable HTTP on the Public listener.',
})
  .option('config', {
    description: 'Configuration file. Defaults to ~/.config/modgud/modgud.toml.',
    env: 'MODGUD_CONFIG',
    type: 'string',
  })
  .action(async ({ host, options, out, signal }) => {
    const log = timestampedLog((line) => out.print(line));
    const path =
      options.config === undefined
        ? defaultConfigPath(host.home)
        : resolve(host.cwd, options.config);
    const config = await readConfig(path).catch((error: unknown) =>
      out.fatal(loggable(`Invalid configuration in ${path}: ${describeError(error)}`)),
    );
    const listener = createPublicListener({ config, log, parentEnvironment: host.env });
    const server = listen(config, listener.fetch, (message) => out.fatal(loggable(message)));
    try {
      const services = Object.keys(config.services).map((name) => `/${name}/mcp`);
      log.info(`Listening on ${server.url.href} for ${services.join(', ')}.`);
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      await listener.close();
      await server.stop(true);
      log.info('Stopped.');
    }
  });
