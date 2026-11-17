import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool, type ClientConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { probePass } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import * as maintenance from '../../src/bot/internalSetup/utils/maintenance';
import { maintenanceCause } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { setBackendKind } from '../helpers/backendKind';
import { freshDatabaseUrl, startPostgres } from '../helpers/postgres';
import { copyStore, provision, setGeneration } from '../helpers/nb5Pg';
import { block, botUrl, makeBotRole, running, waitFor, writeOrder } from '../helpers/nx5Pg';

// NX5 test 9 (sheets/NX5.md decisions 2, 8, 11 and 13): after the copy and the raise, C's row is void at the new
// generation; the bot role on C is refused until Running there (NOLOGIN, then one transaction with LOGIN, 'running'
// and no answers), and its reads then show the order ended; on M, a process that booted in maintenance with cause
// order during the wait leaves after Running on M. Fails today for the last case (no order).

const MESSAGE = 'Moving the main database tonight.';
let container: StartedPostgreSqlContainer;
const pools: Pool[] = [];
const stores: ClaimStore[] = [];
let M: { pool: Pool; url: string; name: string };
let C: { pool: Pool; url: string; name: string };

async function database(prefix: string) {
  const url = await freshDatabaseUrl(container, prefix);
  const pool = new Pool({ connectionString: url, max: 4 });
  pools.push(pool);
  await provision(url, pool);
  await makeBotRole(pool);
  const name = new URL(url).pathname.slice(1);
  return { pool, url: botUrl(container.getHost(), container.getPort(), name), name };
}

beforeAll(async () => {
  container = await startPostgres();
  M = await database('nx5m');
  C = await database('nx5c');
  await setGeneration(M.pool, 'M', 1);
  await running(M.pool);
}, 180_000);
afterAll(async () => {
  for (const s of stores) await s.end().catch(() => undefined);
  maintenance._resetMaintenance();
  maintenance._setMaintenanceSender(null);
  setBackendKind(null);
  delete process.env.DATA_BACKEND_URL;
  for (const pool of pools) await pool.end().catch(() => undefined);
  await container?.stop();
});

const pass = (url: string) => probePass(parseAddressList(url), { session: (config: ClientConfig) => new Client(config) });
const readOrder = (url: string) => {
  const store = new ClaimStore(url, claimTimings(30), () => undefined);
  stores.push(store);
  return (store as any).readSaveOrder();
};

describe('test 9: the new main of a planned move', () => {
  it('on M, a process that boots in maintenance during the wait has cause order, and leaves after Running on M', async () => {
    setBackendKind('postgres');
    process.env.DATA_BACKEND_URL = M.url;
    writeMaintenanceFile('running', 'The last message.');
    const sent: any[] = [];
    maintenance._setMaintenanceSender(message => { sent.push(message); });
    await writeOrder(M.pool, 'o-9', MESSAGE);
    const decision = await maintenance.decideBoot();
    expect(decision).toEqual({ mode: 'maintenance', cause: 'order', message: MESSAGE });
    await maintenance.runMaintenanceBoot(decision as any, { shardRecord: () => null, login: async () => undefined });
    expect(maintenanceCause()).toBe('order');
    await new Promise(resolve => { setTimeout(resolve, 6_000); });
    expect(sent.filter(s => s.type === 'control:restart-bot')).toEqual([]);
    await running(M.pool);
    await waitFor(() => sent.some(s => s.type === 'control:restart-bot'), 15_000);
  }, 120_000);

  it('after the copy and the raise, C\'s row is void at the new generation', async () => {
    await writeOrder(M.pool, 'o-9b', MESSAGE);
    await block(M.pool);
    await copyStore(M.pool, C.pool);
    const row = (await M.pool.query(`SELECT order_id, state, message, generation, reason, up_ms FROM smdb_manager.save_order`)).rows[0];
    await running(C.pool);
    await C.pool.query(`UPDATE smdb_manager.save_order SET order_id = $1, state = $2, message = $3, generation = $4, reason = $5, up_ms = $6`,
      [row.order_id, row.state, row.message, row.generation, row.reason, row.up_ms]);
    await setGeneration(C.pool, 'C', 2);
    await block(C.pool);
    const refused = await pass(C.url);
    expect(refused[0].kind).toBe('refused');
    expect((await C.pool.query(`SELECT order_id, state FROM smdb_manager.save_order`)).rows[0]).toEqual({ order_id: 'o-9b', state: 'maintenance' });
    const current = (await C.pool.query(`SELECT generation = coalesce((SELECT generation FROM smdb_manager.generation), 0) AS current FROM smdb_manager.save_order`)).rows[0].current;
    expect(current).toBe(false);
  }, 120_000);

  it('the bot role on C is refused until Running there, then reads no current maintenance order and no answers', async () => {
    expect((await pass(C.url))[0].kind).toBe('refused');
    await running(C.pool);
    const answered = await pass(C.url);
    expect(answered[0]).toMatchObject({ kind: 'answered', generation: 2, saveOrder: { state: 'running', current: true } });
    expect(await readOrder(C.url)).toMatchObject({ state: 'running', current: true });
    expect((await C.pool.query(`SELECT count(*)::int AS n FROM smdb_manager.save_acks`)).rows[0].n).toBe(0);
    await running(M.pool);
  }, 120_000);
});
