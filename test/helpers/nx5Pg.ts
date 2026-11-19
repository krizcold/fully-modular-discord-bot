import type { Pool } from 'pg';
import { expect, vi } from 'vitest';

import { shardOfGuild } from '../../src/bot/internalSetup/utils/panelRequestShape';
import { setBackendKind } from './backendKind';

// NX5's real-Postgres helpers (sheets/NX5.md items 7 to 9). The manager's side (NM33, switchSql.ts) is not built when
// these tests are written, so its statements are copied here from the sheet's decisions 2 and 4; once NM33 lands they
// are replaced by the text at the manager commit the build names, as nb5Pg.ts copies NM5's DDL.

export const BOT_ROLE = 'smdb_nx5_bot';
export const BOT_PASSWORD = 'pw';

/** Decision 2's SAVE_ORDER_DDL(user): the schema, the generation table, both new tables and the bot role's grants. */
export const SAVE_ORDER_DDL = (user: string) => `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;
CREATE TABLE IF NOT EXISTS smdb_manager.save_order (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), order_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('maintenance', 'running')), message text, generation bigint NOT NULL,
  reason text NOT NULL CHECK (reason IN ('order', 'restore')), up_ms bigint NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.save_acks (
  process_id text PRIMARY KEY, order_id text NOT NULL, node_id text, node_name text, saved boolean NULL,
  unsaved_guilds int, unsaved_files int, unanswered_guilds int, unconfirmed_files int, unanswered_files int,
  resave_guilds int NOT NULL DEFAULT 0,
  acked_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO ${user};
GRANT SELECT ON smdb_manager.save_order TO ${user};
GRANT SELECT, INSERT, UPDATE ON smdb_manager.save_acks TO ${user};`;

const CURRENT_GENERATION = 'coalesce((SELECT generation FROM smdb_manager.generation), 0)';

/** Decision 4's order step under an open login: a new order id, 'maintenance', the current generation and up_ms, no answers. */
export async function writeOrder(pool: Pool, orderId: string, message: string, user = BOT_ROLE): Promise<void> {
  await pool.query(`BEGIN; ${SAVE_ORDER_DDL(user)}
    INSERT INTO smdb_manager.save_order (order_id, state, message, generation, reason, up_ms)
      VALUES ('${orderId}', 'maintenance', '${message.replace(/'/g, "''")}', ${CURRENT_GENERATION}, 'order',
        (SELECT up_ms FROM smdb_data.claim_clock))
      ON CONFLICT (one_row) DO UPDATE SET order_id = EXCLUDED.order_id, state = EXCLUDED.state, message = EXCLUDED.message,
        generation = EXCLUDED.generation, reason = EXCLUDED.reason, up_ms = EXCLUDED.up_ms, at = now();
    DELETE FROM smdb_manager.save_acks;
    COMMIT;`);
}

/** Decision 4's Running transaction: the DDL, LOGIN, the row at 'running' and the current generation, every answer deleted. */
export async function running(pool: Pool, user = BOT_ROLE): Promise<void> {
  await pool.query(`BEGIN; ${SAVE_ORDER_DDL(user)}
    ALTER ROLE ${user} LOGIN;
    INSERT INTO smdb_manager.save_order (order_id, state, message, generation, reason, up_ms)
      VALUES (md5(random()::text), 'running', '', ${CURRENT_GENERATION}, 'order', NULL)
      ON CONFLICT (one_row) DO UPDATE SET state = 'running', reason = 'order', generation = EXCLUDED.generation, at = now();
    DELETE FROM smdb_manager.save_acks;
    COMMIT;`);
}

/** The block and end-sessions steps: NOLOGIN, then every session of the role ended. */
export async function block(pool: Pool, user = BOT_ROLE): Promise<void> {
  await pool.query(`ALTER ROLE ${user} NOLOGIN`);
  await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [user]);
}

/**
 * The bot role the bot processes log in as (not a superuser), with what the bot's boot checks on the pool's database:
 * CREATE on the database and the store's privileges, as helpers/nb16Rig.ts grantBot gives them.
 */
export async function makeBotRole(pool: Pool, user = BOT_ROLE): Promise<void> {
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN CREATE ROLE ${user} LOGIN PASSWORD '${BOT_PASSWORD}'; END IF; END $$`);
  const database = (await pool.query(`SELECT current_database() AS d`)).rows[0].d as string;
  await pool.query(`GRANT CREATE ON DATABASE "${database.replace(/"/g, '""')}" TO ${user}`);
  await pool.query(`GRANT USAGE ON SCHEMA smdb_data TO ${user}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${user}`);
  await pool.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO ${user}`);
}

export async function ackRows(pool: Pool, orderId: string): Promise<Array<{ process_id: string; saved: boolean | null; node_name: string }>> {
  return (await pool.query(`SELECT process_id, saved, node_name FROM smdb_manager.save_acks WHERE order_id = $1 ORDER BY process_id`, [orderId])).rows;
}

/** A guild id whose shard of `count` is `shard`. */
export function guildOn(shard: number, count: number, seed = 400_000_000_000_000_000n): string {
  for (let id = seed; ; id += 1n << 22n) {
    if (shardOfGuild(id.toString(), count) === shard) return id.toString();
  }
}

/** A claim row the process holds on this database, live far above the clock. */
export async function holdShard(pool: Pool, processId: string, nodeName: string, shardId: number, count: number, claim = 1): Promise<void> {
  await pool.query(
    `INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $5, 30000, 1000000000)
     ON CONFLICT (shard_count, shard_id) DO UPDATE SET claim = EXCLUDED.claim, holder_process = EXCLUDED.holder_process,
       holder_node = EXCLUDED.holder_node, holder_name = EXCLUDED.holder_name, expires_up_ms = EXCLUDED.expires_up_ms, released = false`,
    [count, shardId, claim, processId, `n-${nodeName}`, nodeName],
  );
}

export interface BotProcess {
  name: string;
  me: { processId: string; nodeId: string; nodeName: string };
  /** The process's own module graph: maintenance.ts, dataManager.ts and the gate. */
  m: any;
  dm: any;
  gate: any;
  /** Accepts a write for the guild into the working set (not yet flushed). */
  write(guildId: string, value: unknown): void;
  stop(): Promise<void>;
}

/**
 * One bot process on a real database in its own module graph (vi.resetModules), as integration/nb4Maintenance.pg.test.ts
 * loads one: its PostgresBackend and working set, its claims store and lanes on `url`, the order source attached and
 * every order read fed to maintenance.ts as shardBoot wires it. The shard's claim row is written by the caller.
 */
export async function startBotProcess(name: string, url: string, shard: { shardId: number; shardCount: number; claim: number }, guildIds: string[]): Promise<BotProcess> {
  // The static import: vi.resetModules keeps setup.ts's envLoader mock, which reads the copy of backendKind loaded first.
  setBackendKind('postgres');
  vi.resetModules();
  const m: any = await import('../../src/bot/internalSetup/utils/maintenance');
  const dm: any = await import('../../src/bot/internalSetup/utils/dataManager');
  const gate: any = await import('../../src/bot/internalSetup/utils/maintenanceGate');
  const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  const { initWorkingSet } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
  const { ClaimStore } = await import('../../src/bot/internalSetup/fleet/claimStore');
  const { ShardClaims } = await import('../../src/bot/internalSetup/fleet/shardClaims');
  const { claimTimings } = await import('../../src/bot/internalSetup/fleet/claimRules');
  const { fixedDatabase } = await import('./fixedDatabase');
  const me = { processId: `p-${name}`, nodeId: `n-${name}`, nodeName: name };
  m._setMaintenanceSender(() => undefined);
  m.markDiscordStarted();
  const backend = new PostgresBackend(fixedDatabase(url));
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  const ws = initWorkingSet(backend);
  dm.setGuildDataBackend?.(backend);
  const token = { nodeId: me.nodeId, claim: shard.claim, processId: me.processId, shardId: shard.shardId, shardCount: shard.shardCount };
  for (const guildId of guildIds) expect(await ws.hydrate(guildId, token)).toBe('ready');
  const timings = { ...claimTimings(30), renewMs: 1000 };
  const store = new ClaimStore(url, timings, () => backend.notifyLoginRefused?.());
  m.attachSaveOrderSource({ me, read: () => (store as any).readSaveOrder(), writeAck: (ack: unknown) => (store as any).writeSaveAck(ack) });
  m.watchDataBackend(backend, { retryMs: 1000 });
  const claims = new ShardClaims({
    store, me, timings, capacity: 4, takeoverSeconds: 30, returns: true, restartable: false, startedAt: Date.now(),
    fitness: () => m.maintenanceUnfit(),
    gateClosed: () => gate.isMaintenanceGateClosed(),
    isStopping: () => false,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: () => false,
    log: { log: () => undefined, warn: () => undefined, error: () => undefined },
    onSaveOrder: (read: unknown) => m.noteSaveOrder(read),
  } as any);
  claims.start();
  return {
    name, me, m, dm, gate,
    write(guildId, value) {
      expect(dm.saveDataTracked('x.json', { guildId, category: 'nx5' }, value).outcome).toBe('saved');
    },
    async stop() {
      await claims.stopLanes().catch(() => undefined);
      await store.end().catch(() => undefined);
      m.attachSaveOrderSource(null);
      m._resetMaintenance();
      await backend.stop();
    },
  };
}

export const botUrl = (host: string, port: number, database: string) =>
  `postgres://${BOT_ROLE}:${BOT_PASSWORD}@${host}:${port}/${database}`;

export const docOf = async (pool: Pool, guildId: string): Promise<unknown> => {
  const row = (await pool.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = 'nx5' AND filename = 'x.json'`, [guildId])).rows[0];
  return row ? JSON.parse(row.doc) : null;
};

export const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export async function waitFor(check: () => Promise<boolean> | boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
    await sleep(250);
  }
}
