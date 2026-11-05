import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { takeShard } from '../helpers/pgClaims';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB11 fix round 5 (NB11-R5-data-2, NB11-R5-T1): a given batch that does not exist answers no-entry before the live
// check, on a real Postgres.

const SECOND = 1000;

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;
let claim: number;
let guilds = 920_000;

const freshGuild = () => String(++guilds);
const tokenOf = (c: number): FenceToken => ({ nodeId: 'node-a', claim: c, processId: 'process-a', shardId: 0, shardCount: 1 });
const none = () => null;
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  backend = new PostgresBackend({ url: container.getConnectionUri() });
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await sleep(100);
  expect(backend.connectionState().state).toBe('ready');
  claim = (await takeShard(direct, { processId: 'process-a', nodeId: 'node-a' })).claim!;
});

afterAll(async () => {
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

async function bury(guildId: string, retiredAt: number, docs: Record<string, string>): Promise<void> {
  for (const [filename, doc] of Object.entries(docs)) {
    await direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', $2, 'doc', $3, $4, 'test')`, [guildId, filename, doc, retiredAt]);
  }
}

const liveDocs = async (g: string) => (await direct.query(`SELECT filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 ORDER BY filename`, [g])).rows;

describe('a given batch that does not exist', () => {
  it('a second restore of the same batch after an ok answers no-entry, and the live docs stay', async () => {
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await backend.restoreGuild(g, 5, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: true, moved: 1, retiredAt: 5, reason: 'test' });
    expect(await backend.restoreGuild(g, 5, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'no-entry' });
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
  });

  it('a batch never buried on a guild with live rows answers no-entry; another batch stays in the graveyard', async () => {
    const g = freshGuild();
    await direct.query(`INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, 'm', 'l.jsonl', 'x\n')`, [g]);
    await bury(g, 7, { 'b.json': '{"b":1}' });
    expect(await backend.restoreGuild(g, 5, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'no-entry' });
    expect(await backend.restoreGuild(g, 7, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'live-rows', retiredAt: 7 });
    expect((await direct.query(`SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = $1`, [g])).rowCount).toBe(1);
  });
});
