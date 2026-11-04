import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, provisionStoreInTransaction } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB3: the job provisions its Postgres destination in its own transaction. The statements it sends are the store's
// schema: one CREATE SCHEMA that fails on a schema made since the job looked, 32 hash partitions of each table, and
// the schema version and store id rows.

async function provision(): Promise<{ id: string; sent: Array<{ text: string; params?: unknown[] }> }> {
  const sent: Array<{ text: string; params?: unknown[] }> = [];
  const id = await provisionStoreInTransaction({
    query: async (text: string, params?: unknown[]) => {
      sent.push(params === undefined ? { text } : { text, params });
      return { rows: [] };
    },
  });
  return { id, sent };
}

describe('provisionStoreInTransaction', () => {
  it('creates the schema once, without IF NOT EXISTS', async () => {
    const { sent } = await provision();
    expect(sent[0]).toEqual({ text: 'CREATE SCHEMA smdb_data' });
    expect(sent.filter(s => /CREATE SCHEMA/.test(s.text)).map(s => s.text)).toEqual(['CREATE SCHEMA smdb_data']);
    expect(sent).toHaveLength(76);
  });

  it('creates 32 partitions of each table, named p00 to p31', async () => {
    const { sent } = await provision();
    const expected: string[] = [];
    for (let i = 0; i < 32; i++) {
      const suffix = `p${String(i).padStart(2, '0')}`;
      expected.push(`CREATE TABLE smdb_data.guild_data_${suffix} PARTITION OF smdb_data.guild_data FOR VALUES WITH (MODULUS 32, REMAINDER ${i})`);
      expected.push(`CREATE TABLE smdb_data.guild_append_${suffix} PARTITION OF smdb_data.guild_append FOR VALUES WITH (MODULUS 32, REMAINDER ${i})`);
    }
    expect(sent.filter(s => / PARTITION OF /.test(s.text)).map(s => s.text)).toEqual(expected);
    expect(expected[0]).toContain('guild_data_p00 ');
    expect(expected[63]).toContain('guild_append_p31 ');
  });

  it('stores the schema version and the store id it answers', async () => {
    const { id, sent } = await provision();
    expect(SCHEMA_VERSION).toBe(2);
    expect(sent.slice(-2)).toEqual([
      { text: `INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', $1)`, params: ['{"v":2}'] },
      { text: `INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', $1)`, params: [JSON.stringify(id)] },
    ]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
