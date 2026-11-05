import type { ServiceConfig } from './config.ts';

// The variables a Child inherits from Modgud's own environment (ADR-0002).
// Nothing else from Modgud's environment reaches a Child.
export const BASE_VARIABLES = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'TMPDIR',
  'TZ',
  'USER',
] as const;

// A Child's whole environment: the base variables Modgud has, overridden by
// the Service's configured environment. The Service's Identity variable is
// reserved: it is removed from both, then set only from the Grant, and is
// absent when the Grant has no Identity.
export const childEnvironment = ({
  identity,
  parent,
  service,
}: {
  identity: string | undefined;
  parent: Readonly<Record<string, string | undefined>>;
  service: Pick<ServiceConfig, 'env' | 'identity_env'>;
}): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const name of BASE_VARIABLES) {
    const value = parent[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  Object.assign(environment, service.env);
  if (service.identity_env !== undefined) {
    delete environment[service.identity_env];
    if (identity !== undefined) {
      environment[service.identity_env] = identity;
    }
  }
  return environment;
};
