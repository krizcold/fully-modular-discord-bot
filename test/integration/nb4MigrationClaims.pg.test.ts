import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonBot, listStore, provisionedStore, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB4 decision 25: the rename aside of a store this deployment served refuses only for the claims of a bot process
// that may still save: an unreleased row whose holder's machine row names that process and was seen within its delay.

let rig: PgRig;
const G = '282828282828282828';

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

type How = 'none' | 'released' | 'other-process' | 'not-seen' | 'no-table' | 'live';

async function claims(how: How): Promise<void> {
  await rig.admin.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('1', 'other-node', 0, 5, 1)`);
  if (how === 'none') return;
  if (how === 'no-table') {
    await rig.admin.query('DROP TABLE smdb_data.shard_claims');
    return;
  }
  const seen = how === 'not-seen' ? `now() - interval '31 seconds'` : 'now()';
  await rig.admin.query(`INSERT INTO smdb_data.shard_nodes (node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns, started_at, seen_at)
    VALUES ('other-node', 'Other', $1, 1, 30, true, true, true, now(), ${seen})`, [how === 'other-process' ? 'p-new' : 'p-other']);
  await rig.admin.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, released, ttl_ms, expires_up_ms)
    VALUES (1, 0, 5, 'p-other', 'other-node', 'Other', 'other-node', $1, 30000, 30000)`, [how === 'released']);
}

async function moveToPostgres(how: How) {
  const old = await provisionedStore(rig);
  jsonBot();
  seedFile(`${G}/m/a.json`, '{"a":1}');
  listStore(old);
  await claims(how);
  const service = realService(new FakeHost());
  await service.post({ jobId: `job-claims-${how}`, to: 'postgres' });
  await service.idle();
  return service.status().body.job;
}

describe('the rename aside of a store this deployment served', () => {
  it.each(['none', 'released', 'other-process', 'not-seen', 'no-table'] as const)('proceeds with an unretired row of another node and claims: %s', async how => {
    const job = await moveToPostgres(how);
    expect(job, why(job)).toMatchObject({ state: 'done' });
    expect((await schemas(rig)).some(s => s.startsWith('smdb_superseded_'))).toBe(true);
  });

  it('refuses for a live claim, naming the shard and the machine, and renames nothing', async () => {
    const job = await moveToPostgres('live');
    expect(job, why(job)).toMatchObject({ state: 'failed', stage: 'copying' });
    expect(job.error).toMatch(/has shard claims of bot processes seen in the last 30 s: shard 0 held by Other \(seen \d+ s ago\); stop the bot on those machines \(a clean stop releases its claims\), then retry; it was not renamed$/);
    expect(await schemas(rig)).toEqual(['smdb_data']);
  });
});
