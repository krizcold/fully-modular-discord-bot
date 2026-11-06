import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { MigrationService } from '../../src/bot/internalSetup/utils/dataMigration';
import { getNodeId } from '../../src/bot/internalSetup/fleet/nodeIdentity';
import { jsonBot, realService, resetDatabase, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';
import { takeShard } from '../helpers/pgClaims';
import fs from 'fs';
import path from 'path';

// NB3 decisions 6 and 7: the ownership rows the copy writes.

let rig: PgRig;
const G1 = '210000000000000001';
const G2 = '4194304000000000000';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  delete process.env.FLEET_SHARD_COUNT;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the ownership rows', () => {
  it('one row per guild with a file (node, claim 0, not retired, shard from FLEET_SHARD_COUNT); none for an empty guild', async () => {
    jsonBot();
    seedFile(`${G1}/m/a.json`, '{}');
    seedFile(`${G2}/m/b.json`, '{}');
    fs.mkdirSync(path.join(process.env.DATA_DIR as string, '220000000000000003'), { recursive: true });
    seedFile('global/config.json', '{}');
    process.env.FLEET_SHARD_COUNT = '4';
    const service = realService(new FakeHost());
    await service.post({ jobId: 'job-owner-001', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job?.state, why(service.status().body.job)).toBe('done');
    const { rows } = await rig.admin.query('SELECT guild_id, node_id, shard_id, claim::int AS claim, shard_count, retired_at FROM smdb_data.guild_ownership ORDER BY guild_id');
    expect(rows).toEqual([
      { guild_id: G1, node_id: 'node-pg', shard_id: Number((BigInt(G1) >> 22n) % 4n), claim: 0, shard_count: 4, retired_at: null },
      { guild_id: G2, node_id: 'node-pg', shard_id: Number((BigInt(G2) >> 22n) % 4n), claim: 0, shard_count: 4, retired_at: null },
    ]);
    const meta = await rig.admin.query(`SELECT key FROM smdb_data.meta ORDER BY key`);
    expect(meta.rows.map(r => r.key)).toEqual(['schema_version', 'store_id']);
    const docs = await rig.admin.query(`SELECT count(*)::int AS n FROM smdb_data.guild_data`);
    expect(docs.rows[0].n).toBe(2);
  });

  it('with no FLEET_SHARD_COUNT the shard count is 1, and the first boot hydrates every guild', async () => {
    jsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    const service = realService(new FakeHost());
    await service.post({ jobId: 'job-owner-002', to: 'postgres' });
    await service.idle();
    const { rows } = await rig.admin.query('SELECT shard_count FROM smdb_data.guild_ownership');
    expect(rows).toEqual([{ shard_count: 1 }]);
    const backend = new PostgresBackend(fixedDatabase(rig.url));
    backend.start();
    const until = Date.now() + 60_000;
    while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    const claim = await takeShard(rig.admin, { processId: 'p-pg', nodeId: 'node-pg' });
    const owned = await backend.listOwnedGuilds([0], 1);
    expect(owned).toContain(G1);
    const hydrated = await backend.hydrateGuild(G1, claim);
    expect(hydrated).toMatchObject({ ok: true, docs: [{ key: { module: 'm', filename: 'a.json' }, doc: '{"a":1}' }] });
    await backend.stop();
  });
});

describe('the node id', () => {
  it('comes from /data/global/fleet/node.json when no node id is given, and the bot hydrates with its own', async () => {
    jsonBot();
    seedFile(`${G1}/m/a.json`, '{"a":1}');
    seedFile('global/fleet/node.json', JSON.stringify({ nodeId: 'node-from-file', createdAt: 1 }));
    const service = new MigrationService(new FakeHost(), { lockTimeoutMs: 2000 });
    await service.post({ jobId: 'job-owner-003', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job?.state, why(service.status().body.job)).toBe('done');
    const { rows } = await rig.admin.query('SELECT guild_id, node_id FROM smdb_data.guild_ownership');
    expect(rows).toEqual([{ guild_id: G1, node_id: 'node-from-file' }]);
    expect(getNodeId()).toBe('node-from-file');
    const backend = new PostgresBackend(fixedDatabase(rig.url));
    backend.start();
    try {
      const until = Date.now() + 60_000;
      while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(r => setTimeout(r, 100));
      const claim = await takeShard(rig.admin, { processId: 'p-pg', nodeId: getNodeId() });
      const hydrated = await backend.hydrateGuild(G1, claim);
      expect(hydrated).toMatchObject({ ok: true, docs: [{ key: { module: 'm', filename: 'a.json' }, doc: '{"a":1}' }] });
    } finally {
      await backend.stop();
    }
  });
});
