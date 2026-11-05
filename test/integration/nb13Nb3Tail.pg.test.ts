import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { insertAppend, jsonBot, provisionedStore, realService, resetDatabase, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB13 decision 12 in NB3's copy: a stream's open tail is closed with one newline and named.

let rig: PgRig;
const G = '273737373737373737';
const DEAD = '273737373737373738';
let warn: { mock: { calls: unknown[][] } };

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

async function run(jobId: string, to: 'postgres' | 'file') {
  const service = realService(new FakeHost());
  await service.post({ jobId, to });
  await service.idle();
  return service.status().body.job;
}

async function joined(table: 'guild_append', guildId: string, filename: string): Promise<string | null> {
  const res = await rig.admin.query(
    `SELECT string_agg(chunk, '' ORDER BY seq) AS t FROM smdb_data.${table} WHERE guild_id = $1 AND module = 'm' AND filename = $2`,
    [guildId, filename]);
  return res.rows[0]?.t ?? null;
}

const warned = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[Migration] The stream '));

describe('a stream with an open tail', () => {
  it('7.1 JSON to Postgres closes the guild stream and the graveyard stream with one newline, names both, and leaves the source unchanged', async () => {
    jsonBot();
    seedFile(`${G}/m/s.jsonl`, '{"a":1}\n{"b":');
    seedFile(`_graveyard/${DEAD}-1700000000000/m/g.jsonl`, 'x');
    seedFile(`_graveyard/${DEAD}-1700000000000/.graveyard.json`, JSON.stringify({ guildId: DEAD, reason: 'left the guild', ts: 1 }));
    const job = await run('job-tail-001', 'postgres');
    expect(job?.state, why(job)).toBe('done');
    expect(await joined('guild_append', G, 's.jsonl')).toBe('{"a":1}\n{"b":\n');
    const grave = await rig.admin.query(`SELECT doc FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND filename = 'g.jsonl'`, [DEAD]);
    expect(grave.rows[0]?.doc).toBe('x\n');
    expect(job.closedTails).toEqual(expect.arrayContaining([`m/s.jsonl of guild ${G}`, `m/g.jsonl of graveyard entry ${DEAD}-1700000000000`]));
    expect(job.closedTails).toHaveLength(2);
    expect(warned()).toHaveLength(2);
    expect(warned().join('\n')).toContain(`m/s.jsonl of guild ${G}`);
    expect(warned().join('\n')).toContain(`m/g.jsonl of graveyard entry ${DEAD}-1700000000000`);
    expect(fs.readFileSync(path.join(root, G, 'm', 's.jsonl'), 'utf8')).toBe('{"a":1}\n{"b":');
    expect(fs.readFileSync(path.join(root, '_graveyard', `${DEAD}-1700000000000`, 'm', 'g.jsonl'), 'utf8')).toBe('x');
    // After the switch the bot's own writer appends: a working set on a PostgresBackend, under a shard claim row.
    await rig.admin.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
      VALUES (1, 0, 1, 'p-tail', 'node-tail', 'node-tail', 'node-tail', 30000, 30000) ON CONFLICT DO NOTHING`);
    const token: FenceToken = { nodeId: 'node-tail', claim: 1, processId: 'p-tail', shardId: 0, shardCount: 1 };
    const backend = new PostgresBackend({ url: rig.url });
    backend.start();
    const ws = new WorkingSetManager(backend);
    try {
      const until = Date.now() + 30_000;
      while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
      expect(backend.connectionState().state).toBe('ready');
      expect(await ws.hydrate(G, token)).toBe('ready');
      expect(ws.append(G, 'm', 's.jsonl', '{"c":3}\n')).toBe('accepted');
      expect(await ws.confirm(ws.ticketFor(G), 20_000)).toBe('ok');
    } finally {
      ws.evict(G);
      await backend.stop();
    }
    expect((await joined('guild_append', G, 's.jsonl'))!.split('\n')).toEqual(['{"a":1}', '{"b":', '{"c":3}', '']);
  }, 90_000);

  it('7.2 Postgres to JSON stages the stream with its tail closed, passes both checks and names it', async () => {
    await provisionedStore(rig);
    await insertAppend(rig, G, 'm', 's.jsonl', '{"a":1}\n');
    await insertAppend(rig, G, 'm', 's.jsonl', '{"b":');
    const job = await run('job-tail-002', 'file');
    expect(job?.state, why(job)).toBe('done');
    expect(fs.readFileSync(path.join(root, G, 'm', 's.jsonl'), 'utf8')).toBe('{"a":1}\n{"b":\n');
    expect(job.closedTails).toEqual([`m/s.jsonl of guild ${G}`]);
    expect(warned()).toHaveLength(1);
  }, 60_000);

  it('7.3 a stream that ends in a newline and an empty stream are copied byte for byte and not named', async () => {
    jsonBot();
    seedFile(`${G}/m/s.jsonl`, '{"a":1}\n');
    seedFile(`${G}/m/e.jsonl`, '');
    const job = await run('job-tail-003', 'postgres');
    expect(job?.state, why(job)).toBe('done');
    expect(await joined('guild_append', G, 's.jsonl')).toBe('{"a":1}\n');
    expect(await joined('guild_append', G, 'e.jsonl') ?? '').toBe('');
    expect(job.closedTails ?? []).toEqual([]);
    expect(warned()).toEqual([]);
  }, 60_000);
});
