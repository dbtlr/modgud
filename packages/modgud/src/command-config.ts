import { resolve } from 'node:path';

import type { Host, Out } from '@loomcli/core';

import { defaultConfigPath, readConfig, resolveStorePath, serviceResource } from './config.ts';
import type { Config } from './config.ts';
import { describeError, loggable } from './log.ts';
import type { Log } from './log.ts';
import { openStore } from './store.ts';

// The `--config` option that `serve`, `pair`, and `revoke` share, so every
// command acts on the same configuration file and store.
export const configOption = {
  description: 'Configuration file. Defaults to ~/.config/modgud/modgud.toml.',
  env: 'MODGUD_CONFIG',
  type: 'string',
} as const;

// Where a command reports: `out` for the person who ran it, and Loom's `log`
// for the record. A warning goes to both, because under a service manager
// nobody reads `out`. A fatal message reaches the log through Loom itself.
type Report = { log: Pick<Log, 'warn'>; out: Pick<Out, 'fatal' | 'warn'> };

const warnBoth = ({ log, out }: Report, message: string) => {
  log.warn(message);
  void out.warn(message);
};

// Reads the configuration file `--config` names, or the default one, and ends
// the command with a message naming the file when it is missing or invalid.
// Warns of each retired setting the file still sets.
export const loadConfig = async (
  host: Pick<Host, 'cwd' | 'home'>,
  option: string | undefined,
  report: Report,
): Promise<Config> => {
  const path = option === undefined ? defaultConfigPath(host.home) : resolve(host.cwd, option);
  let loaded: Awaited<ReturnType<typeof readConfig>>;
  try {
    loaded = await readConfig(path);
  } catch (error) {
    return report.out.fatal(loggable(`Invalid configuration in ${path}: ${describeError(error)}`));
  }
  for (const warning of loaded.warnings) {
    warnBoth(report, loggable(`In ${path}: ${warning}`));
  }
  return loaded.config;
};

// Opens the configured OAuth store, or ends the command with a message naming
// the path when its directory or file is unsafe or it cannot be opened.
export const openConfiguredStore = async (
  config: Config,
  host: Pick<Host, 'home'>,
  report: Report,
) => {
  try {
    return await openStore({
      maxTokenLifetimeDays: config.harness.max_token_lifetime_days,
      path: resolveStorePath(config, host.home),
      resource: serviceResource(config, config.harness.service),
      warn: (message) => warnBoth(report, loggable(message)),
    });
  } catch (error) {
    return report.out.fatal(loggable(`Could not open the store: ${describeError(error)}`));
  }
};
