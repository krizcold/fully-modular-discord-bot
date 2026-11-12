import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from 'pg';

const made: ClientConfig[] = [];

vi.mock('../../src/bot/internalSetup/utils/pgClient', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/pgClient')>();
  return {
    ...real,
    shortLivedClient: (config: ClientConfig) => {
      made.push(config);
      return {
        connect: async () => undefined,
        query: async (text: string) => {
          if (/pg_is_in_recovery/.test(text)) return { rows: [{ in_recovery: false }], rowCount: 1 };
          if (/key = 'store_id'/.test(text)) return { rows: [{ value: '"store-7"' }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        end: async () => undefined,
        on() {},
      };
    },
  };
});

import { readStoreId } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

beforeEach(() => {
  made.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('readStoreId', () => {
  it('reads the store id from the database it was given, with a bounded connect and statement time', async () => {
    await expect(readStoreId({ host: 'db.internal', port: 5433, database: 'smdb', user: 'bot' })).resolves.toBe('store-7');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ host: 'db.internal', port: 5433, database: 'smdb', user: 'bot', keepAlive: true });
    expect(made[0].connectionTimeoutMillis).toBeGreaterThan(0);
    expect(made[0].statement_timeout).toBeGreaterThan(0);
  });
});
