import { describe, expect, it } from 'vitest';

import { inspectStore } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

type Row = Record<string, unknown> | null;

const GOOD_META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };

function rel(name: string, kind: string): Record<string, unknown> {
  const table = kind === 'r';
  return {
    name, kind, is_partition: false,
    select: table ? true : null, insert: table ? true : null, update: table ? true : null, delete: table ? true : null,
    usage: null, update_seq: null,
  };
}

const FOUND = {
  role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true,
  relations: [rel('meta', 'r'), rel('meta_pkey', 'i')], meta: GOOD_META,
};

function client(script: { versionNum?: string; encodingRows?: Row[]; versionRows?: Row[] }) {
  return {
    query: async (text: string) => {
      const sql = text.trim();
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: script.versionNum ?? '160004' }], rowCount: 1 } as never;
      if (sql === 'SHOW server_encoding') {
        const rows = script.encodingRows ?? [{ server_encoding: 'UTF8' }];
        return { rows, rowCount: rows.length } as never;
      }
      if (/has_database_privilege/.test(sql)) return { rows: [FOUND], rowCount: 1 } as never;
      if (/^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/.test(sql)) {
        const rows = script.versionRows ?? [];
        return { rows, rowCount: rows.length } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
  };
}

describe('the store check reads the server version', () => {
  it('reads a server_version_num of 0 as no version and goes on to the encoding', async () => {
    const verdict = await inspectStore(client({ versionNum: '0', encodingRows: [{ server_encoding: 'SQL_ASCII' }] }));
    expect(verdict).toMatchObject({ kind: 'refused', cause: 'encoding', found: 'SQL_ASCII' });
  });

  it('reads a negative server_version_num as no version', async () => {
    const verdict = await inspectStore(client({ versionNum: '-120000', encodingRows: [{ server_encoding: 'SQL_ASCII' }] }));
    expect(verdict).toMatchObject({ kind: 'refused', cause: 'encoding' });
  });

  it('reads a fractional server_version_num as no version', async () => {
    const verdict = await inspectStore(client({ versionNum: '120000.5', encodingRows: [{ server_encoding: 'SQL_ASCII' }] }));
    expect(verdict).toMatchObject({ kind: 'refused', cause: 'encoding' });
  });

  it('refuses a server older than PostgreSQL 13', async () => {
    const verdict = await inspectStore(client({ versionNum: '120017' }));
    expect(verdict).toMatchObject({ kind: 'refused', cause: 'server', found: '12.17' });
  });
});

describe('the store check reads the encoding', () => {
  it('refuses an encoding it gets no row for, naming it empty', async () => {
    const verdict = await inspectStore(client({ encodingRows: [] }));
    expect(verdict).toMatchObject({ kind: 'refused', cause: 'encoding', found: '' });
  });
});

describe('the store check reads schema_version', () => {
  it('names a schema_version row without a value column as unreadable', async () => {
    const verdict = await inspectStore(client({ versionRows: [{}] }));
    expect(verdict.kind).toBe('refused');
    expect(JSON.stringify(verdict)).toContain('smdb_data.meta holds a schema_version row with no value');
  });

  it('names a schema_version answer whose row is missing as unreadable', async () => {
    const verdict = await inspectStore(client({ versionRows: [null] }));
    expect(verdict.kind).toBe('refused');
    expect(JSON.stringify(verdict)).toContain('smdb_data.meta holds a schema_version row with no value');
  });
});
