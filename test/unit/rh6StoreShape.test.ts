import { describe, expect, it } from 'vitest';

import {
  gatePrivileges,
  metaGateCause,
  readFoundList,
  type MetaFacts,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const meta = (kind: string): MetaFacts => ({
  kind, keyText: true, valueText: true, valueNotNull: true, rls: false, uniqueKey: true, select: true,
});

function fakeClient(row: { [k: string]: unknown }) {
  const texts: string[] = [];
  return {
    texts,
    query: async (text: string) => {
      texts.push(text);
      return { rows: [row] };
    },
  };
}

describe('rh6: the meta gate names what smdb_data.meta is', () => {
  it.each([
    ['i', 'smdb_data.meta is an index, not a table'],
    ['I', 'smdb_data.meta is a partitioned index, not a table'],
    ['m', 'smdb_data.meta is a materialized view, not a table'],
    ['f', 'smdb_data.meta is a foreign table, not a table'],
    ['c', 'smdb_data.meta is a composite type, not a table'],
    ['v', 'smdb_data.meta is a view, not a table'],
    ['x', 'smdb_data.meta is a relation of kind x, not a table'],
  ])('kind %s reads "%s"', (kind, text) => {
    expect(metaGateCause(meta(kind))).toBe(text);
  });
});

describe('rh6: the found list', () => {
  it('lists relations and meta of every relation kind the catalog check knows', async () => {
    const client = fakeClient({ role: 'r', db: 'd', db_create: true, schema_exists: false, relations: [], meta: null });
    await readFoundList(client);
    expect(client.texts).toHaveLength(1);
    const kinds = "IN ('r','p','i','I','S','v','m','f','c')";
    expect(client.texts[0]).toContain(`c.relkind ${kinds}), '[]'::json) AS relations`);
    expect(client.texts[0]).toContain(`m.relname = 'meta' AND m.relkind ${kinds}) AS meta`);
  });

  it('reads an answer the row leaves out as unknown, so the gate refuses on no privilege it did not see lacked', async () => {
    const client = fakeClient({
      role: 'r', db: 'd', db_create: true, schema_exists: true,
      relations: [{ name: 'kv', kind: 'r', is_partition: false }],
      meta: { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true },
    });
    const found = await readFoundList(client);
    expect(found.schemaUsage).toBeNull();
    expect(found.schemaCreate).toBeNull();
    expect(found.relations[0]).toEqual({
      name: 'kv', kind: 'r', isPartition: false,
      select: null, insert: null, update: null, delete: null, usage: null, updateSeq: null,
    });
    expect(found.meta?.select).toBeNull();
    expect(gatePrivileges(found)).toBeNull();
  });
});
