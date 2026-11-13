import { afterEach, describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => ({ hosts: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/pgClient', async orig => ({
  ...(await orig<any>()),
  shortLivedClient: (config: { host?: string }) => {
    sessions.hosts.push(String(config.host));
    return {
      connect: async () => { throw Object.assign(new Error('role is not permitted to log in'), { code: '28000', severity: 'FATAL' }); },
      query: async () => ({ rows: [] }),
      end: async () => undefined,
      on: () => undefined,
    };
  },
}));

import { acceptAddressList, resetAddressesForTests } from '../../src/utils/databaseAddress';
import { probeLoginAtBoot } from '../../src/bot/internalSetup/utils/maintenance';
import { setBackendKind } from '../helpers/backendKind';

const A = 'postgresql://bot:pw@db7:5432/bot';

afterEach(() => {
  setBackendKind(null);
  resetAddressesForTests();
  sessions.hosts.length = 0;
});

describe('probeLoginAtBoot answers none without a login on a JSON bot', () => {
  it('a file bot that holds an address list opens no session and answers none', async () => {
    setBackendKind('file');
    acceptAddressList(A);
    expect(await probeLoginAtBoot()).toBe('none');
    expect(sessions.hosts).toEqual([]);
  });

  it('a Postgres bot with the same list tries the login and reports the refusal', async () => {
    setBackendKind('postgres');
    acceptAddressList(A);
    expect(await probeLoginAtBoot()).toBe('refused');
    expect(sessions.hosts).toEqual(['db7']);
  });
});
