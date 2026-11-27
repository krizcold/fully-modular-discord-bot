import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { WebuiDataReader, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB50 on real Postgres: the web UI reader's hasDoc answers for a guild_data row only; appended lines alone are none.

const GUILD = '930000000000000001';

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  backend = new PostgresBackend(fixedDatabase(container.getConnectionUri()));
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await sleep(100);
  expect(backend.connectionState().state).toBe('ready');
  setWebuiDataStoreUrl({ url: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  setWebuiDataStoreUrl(null);
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

describe('WebuiDataReader.hasDoc', () => {
  it('is false for a key holding only appended lines and true once a document is stored', async () => {
    const reader = new WebuiDataReader();
    await direct.query(`INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, 'm', 'log.json', 'x\n')`, [GUILD]);
    expect(await reader.hasDoc(GUILD, 'm', 'log.json')).toBe(false);
    expect(await reader.listFiles(GUILD, 'm')).toContain('log.json');
    await direct.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, 'm', 'log.json', '{"a":1}')`, [GUILD]);
    expect(await reader.hasDoc(GUILD, 'm', 'log.json')).toBe(true);
    expect(await reader.hasDoc(GUILD, 'm', 'absent.json')).toBe(false);
  });

  it('answers for a document at the guild root', async () => {
    const reader = new WebuiDataReader();
    await direct.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, '', 'root.json', '{}')`, [GUILD]);
    expect(await reader.hasDoc(GUILD, '', 'root.json')).toBe(true);
  });
});
