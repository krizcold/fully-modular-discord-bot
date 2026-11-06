import { describe, expect, it, vi } from 'vitest';
import { WebuiDataReader, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';

// NB3: a data migration leaves the web UI reader's sessions out of its count of other sessions by their
// application name, so the reader names itself smdb-webui-reader.

const seen = vi.hoisted(() => ({ configs: [] as any[] }));

vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    constructor(config: any) { seen.configs.push(config); }
    on() { return this; }
    async query() { return { rows: [] }; }
    async end() {}
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

describe('WebuiDataReader', () => {
  it('opens its pool under the application name the migration skips', async () => {
    setWebuiDataStoreUrl({ url: 'postgres://reader:pw@db.example:5432/smdb' });
    expect(await new WebuiDataReader().listGuilds()).toEqual([]);
    expect(seen.configs).toHaveLength(1);
    expect(seen.configs[0]).toMatchObject({ host: 'db.example', database: 'smdb', user: 'reader', application_name: 'smdb-webui-reader' });
    setWebuiDataStoreUrl(null);
  });
});
