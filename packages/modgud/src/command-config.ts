import { resolve } from 'node:path';

import type { Host, Out } from '@loomcli/core';

import { defaultConfigPath, readConfig, resolveStorePath, serviceResource } from './config.ts';
import type { Config } from './config.ts';
import { loggable } from './log.ts';
import { openStore } from './store.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The `--config` option that `serve`, `pair`, and `revoke` share, so every
// command acts on the same configuration file and store.
export const configOption = {
  description: 'Configuration file. Defaults to ~/.config/modgud/modgud.toml.',
  env: 'MODGUD_CONFIG',
  type: 'string',
} as const;

// Reads the configuration file `--config` names, or the default one, and ends
// the command with a message naming the file when it is missing or invalid.
export const loadConfig = async (
  host: Pick<Host, 'cwd' | 'home'>,
  option: string | undefined,
  out: Pick<Out, 'fatal'>,
): Promise<Config> => {
  const path = option === undefined ? defaultConfigPath(host.home) : resolve(host.cwd, option);
  try {
    return await readConfig(path);
  } catch (error) {
    return out.fatal(loggable(`Invalid configuration in ${path}: ${describeError(error)}`));
  }
};

// Opens the configured OAuth store, or ends the command with a message naming
// the path when its directory or file is unsafe or it cannot be opened.
export const openConfiguredStore = async (
  config: Config,
  host: Pick<Host, 'home'>,
  out: Pick<Out, 'fatal' | 'warn'>,
) => {
  try {
    return await openStore({
      maxTokenLifetimeDays: config.harness.max_token_lifetime_days,
      path: resolveStorePath(config, host.home),
      resource: serviceResource(config, config.harness.service),
      warn: (message) => void out.warn(loggable(message)),
    });
  } catch (error) {
    return out.fatal(loggable(`Could not open the store: ${describeError(error)}`));
  }
};
