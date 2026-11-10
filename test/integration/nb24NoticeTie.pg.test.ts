import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { readNewestNotice } from '../../src/utils/ownerMessages';
import { _resetWebuiChoice, _setWebuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';
import { _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { FakeOwnerRest } from '../helpers/fakeOwnerRest';
import { liveDocs, probe, provision, setGeneration, sleep, startBot, waitFor, type BotRun } from '../helpers/nb5Pg';
import { freshDatabaseUrl, startPostgres } from '../helpers/postgres';

// NB24 section 8 test 8 [pg]: two databases on the sidecar, each a main at generation 2 (machines A and B) of one
// store, each listed by its own chooser; the switch notices are a fake REST (Discord's nonce dedupe on) that both
// choosers and both routes share. The tie stops both; A's raise and A's notice at 3 reopen A alone.

const TOKEN = 'nb24-token';
const STORE = 'store-nb24';
const G = '880000000000002401';
const DATE = '2026-11-10T12:00:00.000Z';
const P_A = { nodeId: 'A', claim: 40, processId: 'p-a', shardId: 0, shardCount: 1 };
const P_B = { nodeId: 'B', claim: 40, processId: 'p-b', shardId: 0, shardCount: 1 };

// switchSql.ts raiseSql on mgr-int bda0e38 (docker-discord-bot-manager), with no extra statements.
const RAISE_SQL = (machine: string, target: number) => `BEGIN;
CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.handover (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), slot text NOT NULL, machine text NOT NULL,
  generation bigint NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.received (
  push_id text PRIMARY KEY, from_system_id text NOT NULL, from_machine text NOT NULL, generation bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.copies (
  slot text PRIMARY KEY, machine text, client text, seen_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;
INSERT INTO smdb_manager.generation AS g (one_row, machine, generation, since) VALUES (true, '${machine}', ${target}, now())
  ON CONFLICT (one_row) DO UPDATE SET machine = EXCLUDED.machine, generation = EXCLUDED.generation, since = now()
  WHERE g.generation < EXCLUDED.generation;
DELETE FROM smdb_manager.handover;
SELECT generation || '|' || machine || '|' || to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM smdb_manager.generation;
COMMIT;`;

let container: StartedPostgreSqlContainer;
let entryA: string;
let entryB: string;
let poolA: Pool;
let poolB: Pool;
let app: { url: string; close: () => Promise<void> };
let rest: FakeOwnerRest;
let botA: BotRun | null = null;
let botB: BotRun | null = null;

async function claimShard(pool: Pool, p: typeof P_A): Promise<void> {
  await pool.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, $1, $2, $3, $3, $3, 3600000, 3600000)`, [p.claim, p.processId, p.nodeId]);
}

async function routeOn(entry: string, machine: string, generation: number): Promise<{ status: number; body: any }> {
  _resetWebuiChoice();
  _setWebuiChoiceDeps({
    entries: () => parseAddressList(entry),
    probe: entries => probe(...entries.map(e => e.raw)),
    readNotice: async () => ({ kind: 'none' }),
    markerStoreId: () => STORE,
    noticeCheckOff: () => false,
  });
  const res = await fetch(`${app.url}/api/managed/switch-notice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
    body: JSON.stringify({ machine, generation, date: DATE }),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  container = await startPostgres();
  entryA = await freshDatabaseUrl(container, 'nb24a');
  entryB = await freshDatabaseUrl(container, 'nb24b');
  poolA = new Pool({ connectionString: entryA, max: 4 });
  poolB = new Pool({ connectionString: entryB, max: 4 });
  await provision(entryA, poolA, STORE);
  await provision(entryB, poolB, STORE);
  await setGeneration(poolA, 'A', 2);
  await setGeneration(poolB, 'B', 2);
  await claimShard(poolA, P_A);
  await claimShard(poolB, P_B);
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  app = await startApp(x => x.use('/api/managed', createManagedRoutes({} as BotManager)));
  rest = new FakeOwnerRest();
  _setManagedTiming({ notifyMs: 20_000, switchMs: 25_000 });
  _resetOwnerChannel();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}, 240_000);

afterAll(async () => {
  await botA?.stop();
  await botB?.stop();
  await app?.close();
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  FakeOwnerRest.reset();
  _setManagedTiming(null);
  _setWebuiChoiceDeps(null);
  setBackendKind(null);
  vi.restoreAllMocks();
  await poolA?.end();
  await poolB?.end();
  await container?.stop();
});

describe('NB24 test 8: two machines announce generation 2', () => {
  it('both choosers stop on the tie; A reopens only after its raise and its notice at 3; B writes nothing', async () => {
    // helpers/setup.ts resets the backend kind before each test, so a beforeAll setting is gone by here.
    setBackendKind('postgres');
    botA = await startBot([entryA], STORE, async () => true, () => readNewestNotice(), 'A');
    botB = await startBot([entryB], STORE, async () => true, () => readNewestNotice(), 'B');
    expect(await botA.ws.hydrate(G, P_A)).toBe('ready');
    expect(await botB.ws.hydrate(G, P_B)).toBe('ready');

    const first = await routeOn(entryA, 'A', 2);
    expect(first).toMatchObject({ status: 200, body: { success: true, posted: true } });
    const second = await routeOn(entryB, 'B', 2);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ posted: true, present: true, tie: { generation: 2, machines: ['A', 'B'], named: ['A', 'B'] } });

    await waitFor(() => botA!.backend.latchReason() !== null && botB!.backend.latchReason() !== null, 120_000);
    expect(botA.backend.latchReason()).toContain('2 machines announced generation 2: A and B');
    expect(botB.backend.latchReason()).toContain('2 machines announced generation 2: A and B');

    botA.ws.save(G, 'm', 'tie.json', '"during the tie"');
    botB.ws.save(G, 'm', 'tie.json', '"during the tie"');
    await botA.ws.flushAllDirty().catch(() => undefined);
    await botB.ws.flushAllDirty().catch(() => undefined);
    expect((await liveDocs(poolA, G))['tie.json']).toBeUndefined();
    expect((await liveDocs(poolB, G))['tie.json']).toBeUndefined();

    await poolA.query(RAISE_SQL('A', 3));
    await sleep(15_000);
    expect(botA.backend.latchReason()).not.toBeNull();
    expect(botA.moved).toEqual([]);

    const raised = await routeOn(entryA, 'A', 3);
    expect(raised).toMatchObject({ status: 200, body: { success: true, posted: true } });

    await waitFor(() => botA!.moved.length === 1, 120_000);
    expect(botA.moved).toEqual([entryA]);
    await waitFor(async () => {
      await botA!.ws.flushAllDirty().catch(() => undefined);
      return (await liveDocs(poolA, G))['tie.json'] === '"during the tie"';
    }, 60_000);

    await sleep(10_000);
    await botB.ws.flushAllDirty().catch(() => undefined);
    expect(botB.backend.latchReason()).not.toBeNull();
    expect(botB.moved).toEqual([]);
    expect((await liveDocs(poolB, G))['tie.json']).toBeUndefined();
  }, 420_000);
});
