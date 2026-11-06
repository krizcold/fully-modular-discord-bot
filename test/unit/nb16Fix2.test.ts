import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PostgresBackend, SCHEMA_VERSION, partitionDdl, provisionDdl, provisionSchemaDdl, provisionSeedRows,
} from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  checkShape, compareShapes, freshPrivilegeRefusal, freshVersionRefusal, privilegeDifference, storeIdRefusal,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import type { Catalog, CatalogRelation } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

// NB16 code review round 2: the fixes of the gatekeeper's rulings (2026-11-05).

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

type Answer = (sql: string, params?: unknown[]) => unknown;

function scripted(answer: Answer, markerStoreId?: () => string | null) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none', markerStoreId });
  backends.push(backend);
  const sent: string[] = [];
  const client = {
    query: async (statement: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const sql = typeof statement === 'string' ? statement : statement.text;
      const params = typeof statement === 'string' ? values : statement.values;
      sent.push(sql.trim());
      const res = answer(sql.trim(), params);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent };
}

const internals = (b: PostgresBackend) => b as unknown as { provision(): Promise<void>; provisioned: boolean };
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return vi.spyOn(console, 'log').mockImplementation(() => {});
};

const FOUND = /has_database_privilege/;
const VERSION_READ = /SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const STORE_ID_READ = /SELECT 1 FROM ONLY smdb_data\.meta WHERE key = 'store_id'/;
const META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const relRow = (name: string, del = true) => ({
  name, kind: 'r', is_partition: false, select: true, insert: true, update: true, delete: del, usage: null, update_seq: null,
});
const found = (relations: unknown[], meta: unknown) => ({
  rows: [{
    role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true, relations, meta,
  }],
  rowCount: 1,
});
const EMPTY = { rows: [{ role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null }], rowCount: 1 };

function base(answer: Answer): Answer {
  return (sql, params) => {
    if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
    return answer(sql, params);
  };
}

function storeScript(storeIdRows: unknown[]): Answer {
  return base(sql => {
    if (FOUND.test(sql)) return found([relRow('meta')], META);
    if (VERSION_READ.test(sql)) return { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION }) }], rowCount: 1 };
    if (STORE_ID_READ.test(sql)) return { rows: storeIdRows, rowCount: storeIdRows.length };
    return undefined;
  });
}

describe('ruling 1: the scratch and the privilege checks need no seed row', () => {
  it('provisionDdl is the schema statements with the seed rows in place, unchanged in order', () => {
    const all = provisionDdl('smdb_data');
    const seeds = provisionSeedRows('smdb_data');
    expect(seeds).toEqual(['INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (1, 0, now()) ON CONFLICT (id) DO NOTHING']);
    expect(provisionSchemaDdl('smdb_data')).toEqual(all.filter(s => !seeds.includes(s)));
    expect(provisionSchemaDdl('smdb_data')).toHaveLength(17);
    expect(all).toHaveLength(18);
    expect(provisionSchemaDdl('smdb_data').some(s => /^\s*INSERT/i.test(s))).toBe(false);
  });

  it('checkShape builds the scratch with no INSERT', async () => {
    const sent: string[] = [];
    await checkShape({ query: async (text: string) => { sent.push(text); return { rows: [] }; } }, 'provisioned');
    expect(sent.filter(s => /^\s*INSERT/i.test(s))).toEqual([]);
    const ddl = sent.filter(s => /^CREATE /.test(s));
    expect(ddl).toHaveLength(17 + 64);
    expect(sent.filter(s => /smdb_shape_\w+\.claim_clock \(/.test(s))).toHaveLength(1);
  });

  it('a fresh database gets its rows only after the shape and the second found list pass', async () => {
    quiet();
    let lists = 0;
    const { backend, sent } = scripted(base(sql => {
      if (FOUND.test(sql)) return lists++ === 0 ? EMPTY : found([], null);
      if (VERSION_READ.test(sql)) return { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION }) }], rowCount: 1 };
      return undefined;
    }));
    await internals(backend).provision();
    expect(internals(backend).provisioned).toBe(true);
    const lastList = sent.map((s, i) => (FOUND.test(s) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstInsert = sent.findIndex(s => /^INSERT/.test(s));
    expect(lastList).toBeGreaterThan(0);
    expect(firstInsert).toBeGreaterThan(lastList);
    expect(sent.filter(s => /^INSERT/.test(s)).map(s => s.split(' (')[0])).toEqual([
      'INSERT INTO smdb_data.claim_clock', 'INSERT INTO smdb_data.meta', 'INSERT INTO smdb_data.meta',
    ]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['COMMIT']);
  });

  it('a fresh schema whose role lacks DELETE is refused with no row written', async () => {
    quiet();
    let lists = 0;
    const rel = { name: 'meta', kind: 'r', persistence: 'p', is_partition: false };
    const { backend, sent } = scripted(base((sql, params) => {
      if (FOUND.test(sql)) return lists++ === 0 ? EMPTY : found([relRow('meta', false)], META);
      if (/^SELECT c\.relname AS name, c\.relkind/.test(sql) && Array.isArray(params)) return { rows: [rel], rowCount: 1 };
      return undefined;
    }));
    await internals(backend).provision();
    const refusal = freshPrivilegeRefusal('smdb_bot', [
      privilegeDifference('smdb_bot', 'smdb', { scope: 'table', target: 'meta', privilege: 'DELETE' }),
    ]);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(sent.filter(s => /^INSERT/.test(s))).toEqual([]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });
});

describe('ruling 2: a store of the right shape with no store_id row', () => {
  it('with a store id in the marker: refused, nothing written, the fix prints the INSERT of that id', async () => {
    quiet();
    const { backend, sent } = scripted(storeScript([]), () => 'abc-123');
    await internals(backend).provision();
    const refusal = storeIdRefusal('abc-123');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(refusal.fix).toContain(`INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', '"abc-123"')`);
    expect(refusal.fix).not.toMatch(/restore a backup/);
    expect(refusal.reason).toContain('records store abc-123');
    expect(sent.filter(s => /^INSERT/.test(s))).toEqual([]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });

  it('a quote in the recorded id is doubled in the printed statement', () => {
    expect(storeIdRefusal("o'x").fix).toContain(`VALUES ('store_id', '"o''x"')`);
  });

  it('with no store id in the marker: a new id is written, then the claim_clock row, and the store commits', async () => {
    quiet();
    const { backend, sent } = scripted(storeScript([]), () => null);
    await internals(backend).provision();
    expect(internals(backend).provisioned).toBe(true);
    expect(sent.filter(s => /^INSERT/.test(s)).map(s => s.split(' (')[0])).toEqual([
      'INSERT INTO smdb_data.meta', 'INSERT INTO smdb_data.claim_clock',
    ]);
    expect(sent.find(s => /^INSERT INTO smdb_data\.meta/.test(s))).toContain("'store_id'");
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['COMMIT']);
  });

  it('a store that holds its store_id writes only the claim_clock row and never asks the marker', async () => {
    quiet();
    const marker = vi.fn(() => 'abc-123');
    const { backend, sent } = scripted(storeScript([{ '?column?': 1 }]), marker);
    await internals(backend).provision();
    expect(internals(backend).provisioned).toBe(true);
    expect(sent.filter(s => /^INSERT/.test(s))).toEqual(provisionSeedRows('smdb_data'));
    expect(marker).not.toHaveBeenCalled();
  });
});

describe('ruling 3: the transaction reads committed data whatever the role default', () => {
  it('sends SET TRANSACTION ISOLATION LEVEL READ COMMITTED right after BEGIN, before the lock', async () => {
    quiet();
    const { backend, sent } = scripted(storeScript([{ '?column?': 1 }]));
    await internals(backend).provision();
    expect(sent[0]).toBe('BEGIN');
    expect(sent[1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(sent[2]).toMatch(/pg_try_advisory_xact_lock/);
  });
});

describe('ruling 4: another version at the fresh reread', () => {
  it('answers the fresh refusal, rolled back, and not the version latch', async () => {
    quiet();
    const { backend, sent } = scripted(base(sql => {
      if (FOUND.test(sql)) return EMPTY;
      if (VERSION_READ.test(sql)) return { rows: [{ value: '{"v":2}' }], rowCount: 1 };
      return undefined;
    }));
    await internals(backend).provision();
    const refusal = freshVersionRefusal(`smdb_data.meta's schema_version reads {"v":2}`);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(sent.some(s => s.includes("'store_id'"))).toBe(false);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });
});

describe('ruling 5: the lock texts claim no holder', () => {
  it('the wait line names both possible holders', async () => {
    const log = quiet();
    let polls = 0;
    const { backend } = scripted((sql, params) => {
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: polls++ > 0 }], rowCount: 1 };
      return storeScript([{ '?column?': 1 }])(sql, params);
    });
    await internals(backend).provision();
    expect(log.mock.calls.map(c => c[0])).toContain(
      "[PostgresBackend] Waiting for the bootstrap lock, held by another bot process's schema check or a data migration");
  });

  it('the bound fails the attempt with a text that names both possible holders', async () => {
    quiet();
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => { const t = now; now = 300_000; return t; });
    const { backend, sent } = scripted(sql => (/pg_try_advisory_xact_lock/.test(sql) ? { rows: [{ locked: false }], rowCount: 1 } : undefined));
    await expect(internals(backend).provision()).rejects.toThrow(
      "the bootstrap lock stayed held for 300 s by another bot process's schema check or a data migration");
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });
});

function rel(name: string, kind: CatalogRelation['kind'], extra: Partial<CatalogRelation> = {}): CatalogRelation {
  return {
    name, kind, persistence: 'p', isPartition: false, rls: false, forceRls: false, accessMethod: null, partitionKey: null,
    bound: null, parent: null, inherits: [], indexDef: null, indexValid: null, indexTable: null, sequence: null, ...extra,
  };
}
const catalog = (relations: CatalogRelation[]): Catalog => ({ relations, columns: [], constraints: [], rules: [] });

describe('row 11: a partition index of a held index, on a partition the store lacks', () => {
  it('is counted in decision 5 mode; its partition is listed', () => {
    const reference = catalog([
      rel('guild_data', 'p'),
      rel('guild_data_pkey', 'I', { indexTable: 'guild_data' }),
      rel('guild_data_p00', 'r', { isPartition: true, parent: 'smdb_data.guild_data' }),
      rel('guild_data_p00_pkey', 'i', { isPartition: true, parent: 'smdb_data.guild_data_pkey', indexTable: 'guild_data_p00' }),
    ]);
    const store = catalog([rel('guild_data', 'r'), rel('guild_data_pkey', 'i', { indexTable: 'guild_data' })]);
    const result = compareShapes(store, reference, 'unversioned');
    const texts = result.differences.map(d => d.text);
    expect(texts).toContain('smdb_data.guild_data_p00 (table) is missing');
    expect(texts.some(t => t.includes('guild_data_p00_pkey'))).toBe(false);
    expect(result.counted).toBe(1);
  });

  it('is listed in decision 4 mode', () => {
    const reference = catalog([
      rel('guild_data', 'p'),
      rel('guild_data_p00', 'r', { isPartition: true, parent: 'smdb_data.guild_data' }),
      rel('guild_data_p00_pkey', 'i', { isPartition: true, parent: 'smdb_data.guild_data_pkey', indexTable: 'guild_data_p00' }),
    ]);
    const texts = compareShapes(catalog([rel('guild_data', 'p')]), reference, 'provisioned').differences.map(d => d.text);
    expect(texts).toContain('smdb_data.guild_data_p00_pkey (index) is missing');
  });
});

it('partitionDdl is untouched by the split', () => {
  expect(partitionDdl('smdb_data', true)).toHaveLength(64);
});
