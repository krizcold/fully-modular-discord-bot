import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MainChooser, decideMain } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { entryOf, probe, provision, setGeneration, sleep, startPostgresOnFixedPort } from '../helpers/nb5Pg';
import { poolFor } from '../helpers/postgres';

// NB5 section 8 [pg] test 2 (decision 5), a characterization: who may call pg_control_system() and
// pg_postmaster_start_time(), two addresses of one server deciding as one database, and a restart changing `started`.
// Variant (round 4, NB5-R4-HOLD-SAME-DATABASE): a backend whose server restarts under it holds, confirms the restarted
// server as its main, and saves the dirty write there.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let entry: string;

/** The test's own pool; a restart ends its idle clients, which it ignores. */
function adminPool(): Pool {
  const pool = poolFor(container);
  pool.on('error', () => undefined);
  return pool;
}

beforeAll(async () => {
  container = await startPostgresOnFixedPort();
  direct = adminPool();
  entry = entryOf(container);
  await provision(entry, direct, 'store-nb5');
  await setGeneration(direct, 'node-a', 1);
  await direct.query('DROP ROLE IF EXISTS nb5_plain');
  await direct.query("CREATE ROLE nb5_plain LOGIN PASSWORD 'plain-pw'");
  await direct.query('GRANT USAGE ON SCHEMA smdb_data TO nb5_plain');
  await direct.query('GRANT SELECT ON smdb_data.meta TO nb5_plain');
  await direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 1, 'p-a', 'node-a', 'node-a', 'node-a', 30000, 30000)`);
}, 180_000);
afterAll(async () => {
  await direct?.end().catch(() => undefined);
  await container?.stop();
});

describe('sysid and started', () => {
  it('the superuser reads sysid and started; a plain role reads started, and sysid as far as it may call pg_control_system()', async () => {
    const [su] = (await probe(entry)) as any[];
    expect(su).toMatchObject({ kind: 'answered' });
    expect(su.sysid).toMatch(/^\d+$/);
    expect(su.started).toBeTruthy();
    const [plain] = (await probe(entryOf(container, { user: 'nb5_plain', password: 'plain-pw' }))) as any[];
    expect(plain).toMatchObject({ kind: 'answered' });
    expect(plain.started).toBe(su.started);
    const allowed = (await direct.query(`SELECT has_function_privilege('nb5_plain', 'pg_control_system()', 'EXECUTE') AS ok`)).rows[0].ok;
    expect(plain.sysid).toBe(allowed === true ? su.sysid : null);
  });

  it('localhost and 127.0.0.1 of one container decide as one database, not a tie', async () => {
    const a = entryOf(container, { host: 'localhost' });
    const b = entryOf(container, { host: '127.0.0.1' });
    const answers = await probe(a, b);
    expect(answers.map(x => x.kind)).toEqual(['answered', 'answered']);
    const decision = decideMain(answers, { kind: 'none' }, { markerStoreId: 'store-nb5', noticeCheckOff: false });
    expect(decision.outcome).toBe('chosen');
  });

  it('a restart of the container changes started', async () => {
    const [before] = (await probe(entry)) as any[];
    await direct.end().catch(() => undefined);
    await container.restart();
    await sleep(1000);
    direct = adminPool();
    entry = entryOf(container);
    const [after] = (await probe(entry)) as any[];
    expect(after.kind).toBe('answered');
    expect(after.started).not.toBe(before.started);
    expect(after.sysid).toBe(before.sysid);
  }, 120_000);
});

describe('round 4 variant: the hold on the same database', () => {
  it('a restart under a serving backend: the hold, the restarted server confirmed as the main, the dirty write saved there', async () => {
    await direct.end().catch(() => undefined);
    direct = adminPool();
    const chooser = new MainChooser({
      entries: () => parseAddressList(entry),
      probe: entries => probe(...entries.map(e => e.raw)),
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'store-nb5',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    const backend = new PostgresBackend({ chooser } as never);
    backend.start();
    const until = Date.now() + 60_000;
    while (backend.connectionState().state !== 'ready' && Date.now() < until) await sleep(100);
    expect(backend.connectionState().state).toBe('ready');
    chooser.attach(backend, { stopServing: () => undefined, report: () => undefined, markForResave: () => undefined, startLeave: () => undefined });
    const ws = initWorkingSet(backend);
    const token = { nodeId: 'node-a', claim: 1, processId: 'p-a', shardId: 0, shardCount: 1 };
    const g = '880000000000000101';
    expect(await ws.hydrate(g, token)).toBe('ready');
    const states = new Set<string>();
    const sampler = setInterval(() => states.add(backend.connectionState().state), 50);
    await container.restart();
    entry = entryOf(container);
    expect(ws.save(g, 'm', 'a.json', '"after-restart"')).toBe('accepted');
    const deadline = Date.now() + 60_000;
    let saved = false;
    while (!saved && Date.now() < deadline) {
      await ws.flushAllDirty().catch(() => undefined);
      await direct.end().catch(() => undefined);
      direct = adminPool();
      const rows = await direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = 'm' AND filename = 'a.json'`, [g]).catch(() => ({ rows: [] as any[] }));
      saved = rows.rows.length === 1;
      if (!saved) await sleep(1000);
    }
    clearInterval(sampler);
    expect(saved).toBe(true);
    expect(states.has('outage') || states.has('confirming')).toBe(true);
    expect(backend.connectionState().state).toBe('ready');
    expect(backend.latchReason()).toBeNull();
    chooser.stop();
    await backend.stop();
  }, 180_000);
});
