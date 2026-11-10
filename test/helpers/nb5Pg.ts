import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, type ClientConfig, type Pool } from 'pg';
import { expect } from 'vitest';

import { PostgresBackend, checkMoveTarget } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { MainChooser, probePass, settleRetires, type NoticeRead, type ProbeAnswer, type RetireOnWire } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { parseAddressList, showEntry } from '../../src/utils/databaseAddress';
import { fixedDatabase } from './fixedDatabase';

// NB5's real-Postgres helpers: the manager's generation table (NM5's DDL, switchSql.ts on mgr-int bda0e38), entry
// strings for a container and a role, the probe pass over real sessions, and provisioning by the bot's own backend.

export const GENERATION_DDL = `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;`;

/** The row the manager keeps: one row, raised in place. `since` is the database's own now() unless given. */
export async function setGeneration(pool: Pool, machine: string, generation: number, since?: string): Promise<void> {
  await pool.query(GENERATION_DDL);
  await pool.query(
    `INSERT INTO smdb_manager.generation (machine, generation, since) VALUES ($1, $2, COALESCE($3::timestamptz, now()))
     ON CONFLICT (one_row) DO UPDATE SET machine = EXCLUDED.machine, generation = EXCLUDED.generation, since = EXCLUDED.since`,
    [machine, generation, since ?? null],
  );
}

export function entryOf(container: StartedPostgreSqlContainer, over: { user?: string; password?: string; host?: string } = {}): string {
  const user = encodeURIComponent(over.user ?? container.getUsername());
  const password = encodeURIComponent(over.password ?? container.getPassword());
  return `postgres://${user}:${password}@${over.host ?? container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
}

/** One probe pass over real sessions, as boot.ts runs it. */
export function probe(...entries: string[]): Promise<ProbeAnswer[]> {
  return probePass(parseAddressList(entries.join(',')), { session: (config: ClientConfig) => new Client(config) });
}

/** The bot's own provisioning of the data schema, then the store id the recognition guard would record. */
export async function provision(entry: string, pool: Pool, storeId: string | null = null): Promise<void> {
  const backend = new PostgresBackend(fixedDatabase(entry));
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  await backend.stop();
  if (storeId !== null) {
    await pool.query(
      `INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(storeId)],
    );
  }
}

export const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** A free host port, so a container restarted under a test keeps its address. */
export async function freePort(): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/** The sidecar's image on a fixed host port: a restart keeps the address the backend chose. */
export async function startPostgresOnFixedPort(): Promise<StartedPostgreSqlContainer> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { POSTGRES_IMAGE } = await import('./postgres');
  return new PostgreSqlContainer(POSTGRES_IMAGE).withExposedPorts({ container: 5432, host: await freePort() }).start();
}

const COPIED_TABLES = ['meta', 'guild_ownership', 'shard_claims', 'guild_data', 'guild_append', 'guild_data_graveyard'];

/**
 * A copy of one provisioned store's rows into another provisioned database, standing for a pg_dump and restore of
 * smdb_data (both databases provisioned by the bot at one schema version, so the tables match).
 */
export async function copyStore(from: Pool, to: Pool): Promise<void> {
  for (const table of COPIED_TABLES) {
    await to.query(`DELETE FROM smdb_data.${table}`);
    const { rows, fields } = await from.query(`SELECT * FROM smdb_data.${table}`);
    const columns = fields.map(f => `"${f.name}"`).join(', ');
    for (const row of rows) {
      const values = fields.map(f => row[f.name]);
      const marks = values.map((_, i) => `$${i + 1}`).join(', ');
      await to.query(`INSERT INTO smdb_data.${table} (${columns}) OVERRIDING SYSTEM VALUE VALUES (${marks})`, values);
    }
  }
  await to.query(`SELECT setval('smdb_data.guild_append_seq', GREATEST((SELECT max(seq) FROM smdb_data.guild_append), 1))`);
}

/** Client sessions on a database other than the given application's (the test's own admin pool). */
export async function otherSessions(pool: Pool, ownApp: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
        AND coalesce(application_name, '') <> $1`, [ownApp]);
  return rows[0].n;
}

export interface BotRun {
  chooser: MainChooser;
  backend: PostgresBackend;
  ws: WorkingSetManager;
  /** The step's leave requests (decision 11), and the entries the move reached (f). */
  leaves: string[];
  moved: string[];
  /** Retires step (e) settles, each removed once settled, and the guilds whose retire reached the target. */
  retires: RetireOnWire[];
  reached: string[];
  /** The list in use; a test adds the new main's address to it, as the addresses hook does. */
  list: string[];
  stop(): Promise<void>;
}

/**
 * A bot process's data side on real databases: the real chooser over `list`, the backend, the working set and the
 * move's steps, step (e) the real settleRetires as boot.ts wires it. The claims step answers true (the target holds
 * this process's claim rows) unless one is given; the switch notices read none unless a reader is given.
 */
export async function startBot(
  list: string[], recordedStore: string, claims: (entry: string) => Promise<boolean> = async () => true,
  readNotice: () => Promise<NoticeRead> = async () => ({ kind: 'none' }), nodeName = 'node-a',
): Promise<BotRun> {
  const r = { leaves: [] as string[], moved: [] as string[], retires: [] as RetireOnWire[], reached: [] as string[], list: [...list] } as BotRun;
  const chooser = new MainChooser({
    entries: () => parseAddressList(r.list.join(',')),
    probe: entries => probe(...entries.map(e => e.raw)),
    readNotice,
    sendWaitDm: async () => ({ ok: true }),
    markerStoreId: () => recordedStore,
    noticeCheckOff: () => false,
    nodeName: () => nodeName,
    onWait: () => undefined,
  });
  const backend = new PostgresBackend({ chooser } as never);
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await sleep(100);
  expect(backend.connectionState().state).toBe('ready');
  const ws = initWorkingSet(backend);
  chooser.attach(backend, {
    stopServing: () => undefined,
    report: () => undefined,
    markForResave: () => ws.markForResave(showEntry(backend.chosenEntry()!)),
    startLeave: reason => { r.leaves.push(reason); },
  });
  backend.setMoveSteps({
    checkTarget: entry => checkMoveTarget(entry, () => recordedStore),
    claims,
    settleRetires: (epoch, entry) => settleRetires(backend, epoch, entry, {
      retiresToSettle: () => [...r.retires],
      settled: guildId => { r.retires = r.retires.filter(x => x.guildId !== guildId); },
      reached: guildId => { r.reached.push(guildId); ws.dropRetired(guildId); },
      flagEpoch: flagged => ws.flagEpoch(flagged),
    }),
    moved: entry => { r.moved.push(entry); },
  });
  return Object.assign(r, {
    chooser, backend, ws,
    async stop() { chooser.stop(); await backend.stop(); },
  });
}

/** Polls a condition every 250 ms; throws once ms passed. */
export async function waitFor(check: () => Promise<boolean> | boolean, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
    await sleep(250);
  }
}

export const liveDocs = async (pool: Pool, guildId: string): Promise<Record<string, string>> =>
  Object.fromEntries((await pool.query(`SELECT filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 ORDER BY filename`, [guildId])).rows.map(r => [r.filename, r.doc]));
