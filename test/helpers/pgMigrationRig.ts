import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import net from 'net';
import { Client, Pool } from 'pg';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { MigrationService, type ServiceOptions } from '../../src/bot/internalSetup/utils/dataMigration';
import { FakeHost, JOURNAL, MARKER, STORES, freshJsonBot, writeJson } from './migrationRig';
import { startPostgres } from './postgres';

// NB3's job against a real Postgres (testcontainers), with the host stand-in of migrationRig.

export interface PgRig {
  container: StartedPostgreSqlContainer;
  url: string;
  admin: Pool;
}

export async function startRig(): Promise<PgRig> {
  const container = await startPostgres();
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  const url = `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  const admin = new Pool({ connectionString: url, max: 4, application_name: 'smdb-webui-reader' });
  admin.on('error', () => undefined);
  return { container, url, admin };
}

export async function stopRig(rig: PgRig | undefined): Promise<void> {
  await rig?.admin.end();
  await rig?.container.stop();
}

/** Drops every schema the bot and the job make, so each test starts from an empty database. */
export async function resetDatabase(rig: PgRig): Promise<void> {
  const { rows } = await rig.admin.query(`SELECT nspname FROM pg_namespace WHERE nspname = 'smdb_data' OR nspname LIKE 'smdb\\_superseded\\_%'`);
  for (const r of rows) await rig.admin.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
}

/** A store provisioned by the bot's own backend, its store id and the marker naming it. */
export async function provisionedStore(rig: PgRig): Promise<string> {
  const backend = new PostgresBackend({ url: rig.url });
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(r => setTimeout(r, 100));
  await backend.stop();
  await sessionsGone(rig);
  const { rows } = await rig.admin.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
  const storeId = JSON.parse(rows[0].value) as string;
  writeJson(MARKER, { live: 'postgres', storeId, flippedAt: 1 });
  return storeId;
}

/**
 * Waits until no session of the role but the rig's own is left (a closed client's backend exits a moment later).
 * Throws after boundMs, naming each session still open.
 */
export async function sessionsGone(rig: PgRig, boundMs = 10_000): Promise<void> {
  const until = Date.now() + boundMs;
  for (;;) {
    const { rows } = await rig.admin.query(
      `SELECT application_name, state, wait_event, left(query, 80) AS query FROM pg_stat_activity WHERE usename = current_user AND backend_type = 'client backend' AND coalesce(application_name, '') <> 'smdb-webui-reader'`,
    );
    if (rows.length === 0) return;
    if (Date.now() > until) {
      const open = rows.map(r => `application_name=${JSON.stringify(r.application_name)} state=${r.state} wait_event=${r.wait_event} query=${JSON.stringify(r.query)}`);
      throw new Error(`${rows.length} database session(s) still open after ${boundMs / 1000} s:\n${open.join('\n')}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

export async function insertDoc(rig: PgRig, guildId: string, module: string, filename: string, doc: string): Promise<void> {
  await rig.admin.query('INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)', [guildId, module, filename, doc]);
}

export async function insertAppend(rig: PgRig, guildId: string, module: string, filename: string, chunk: string): Promise<void> {
  await rig.admin.query('INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, $2, $3, $4)', [guildId, module, filename, chunk]);
}

export function realService(host = new FakeHost(), extra: ServiceOptions = {}): MigrationService {
  return new MigrationService(host, { nodeId: () => 'node-pg', lockTimeoutMs: 2000, ...extra });
}

export function jsonBot(): void {
  freshJsonBot();
}

/** A listed store id comes with the journal of the job that listed it (G5): one to Postgres that committed and stopped before the switch. */
export function listStore(id: string): void {
  writeJson(STORES, { storeIds: [id] });
  writeJson(JOURNAL, { jobId: 'job-dest-earlier', to: 'postgres', stage: 'committing', startedAt: 1, storeId: id });
}

/** A client named as another bot's pool would be (no application_name). */
export async function otherSession(rig: PgRig, app?: string): Promise<Client> {
  const c = new Client({ connectionString: rig.url, application_name: app });
  await c.connect();
  return c;
}

export async function schemas(rig: PgRig): Promise<string[]> {
  const { rows } = await rig.admin.query(`SELECT nspname FROM pg_namespace WHERE nspname = 'smdb_data' OR nspname LIKE 'smdb\\_superseded\\_%' ORDER BY nspname`);
  return rows.map(r => r.nspname);
}

/** A TCP hop in front of the container that can drop the traffic of every connection. */
export class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private muted = false;
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  stall(): void {
    this.stalled = true;
  }

  /** Drops only the server's answers: what the client sends still reaches the server. */
  mute(): void {
    this.muted = true;
  }

  restore(): void {
    this.stalled = false;
    this.muted = false;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private accept(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      this.sockets.add(from);
      const answers = from === upstream;
      from.on('data', chunk => { if (!this.stalled && !(answers && this.muted)) to.write(chunk); });
      from.on('close', () => {
        this.sockets.delete(from);
        to.destroy();
      });
      from.on('error', () => { /* the close that follows ends the other side */ });
    }
  }
}

/** A hop in front of the rig's container and the database address through it. */
export async function startHop(rig: PgRig): Promise<{ hop: Hop; url: string }> {
  const target = new URL(rig.url);
  const hop = new Hop({ host: target.hostname, port: Number(target.port) });
  const port = await hop.listen();
  target.hostname = '127.0.0.1';
  target.port = String(port);
  return { hop, url: target.toString() };
}
