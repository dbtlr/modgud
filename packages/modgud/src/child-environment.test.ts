import { describe, expect, test } from 'bun:test';

import { childEnvironment } from './child-environment.ts';

const parent = {
  AWS_SECRET_ACCESS_KEY: 'leak',
  HOME: '/home/someone',
  LANG: 'C.UTF-8',
  PATH: '/usr/bin',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
};

describe('childEnvironment', () => {
  test('copies only the base variables from the parent', () => {
    expect(childEnvironment({ identity: undefined, parent, service: { env: {} } })).toEqual({
      HOME: '/home/someone',
      LANG: 'C.UTF-8',
      PATH: '/usr/bin',
    });
  });

  test('lets a configured value override a base value', () => {
    expect(
      childEnvironment({
        identity: undefined,
        parent,
        service: { env: { NORN_ROOT: '/vault', PATH: '/opt/bin' } },
      }),
    ).toEqual({ HOME: '/home/someone', LANG: 'C.UTF-8', NORN_ROOT: '/vault', PATH: '/opt/bin' });
  });

  test('sets the Identity variable only from the Grant', () => {
    const environment = childEnvironment({
      identity: 'drew',
      parent: { ...parent, USER: 'operator' },
      service: { env: { USER: 'configured' }, identity_env: 'USER' },
    });

    expect(environment.USER).toBe('drew');
  });

  test('leaves the Identity variable absent when the Grant has no Identity', () => {
    const environment = childEnvironment({
      identity: undefined,
      parent: { ...parent, USER: 'operator' },
      service: { env: { USER: 'configured' }, identity_env: 'USER' },
    });

    expect(environment).not.toHaveProperty('USER');
  });
});
