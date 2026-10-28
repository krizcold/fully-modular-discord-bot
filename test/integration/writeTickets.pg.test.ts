import net from 'net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { setBackendKind } from '../helpers/backendKind';
import { initWorkingSet, WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { confirmWrite, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { poolFor, startPostgres } from '../helpers/postgres';

// BT-1 against a real store (notes/BT.md, "BT-1 design sheet", Tests first):
// the connection is cut while a write's flush is on the wire, and its ticket
// answers held; once the store is reachable again, the same ticket answers ok.

/** A TCP hop in front of the container that can drop the traffic of every connection, and cut them all. */
class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private cut = false;
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  /** Bytes in both directions are dropped, so a query sent now never reaches the store. */
  stall(): void {
    this.stalled = true;
  }

  /** Every open connection is destroyed, and new ones are refused until restore. */
  cutAll(): void {
    this.cut = true;
    for (const socket of this.sockets) socket.destroy();
  }

  restore(): void {
    this.stalled = false;
    this.cut = false;
  }

  close(): Promise<void> {
    this.cutAll();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private accept(client: net.Socket): void {
    if (this.cut) {
      client.destroy();
      return;
    }
    const upstream = net.connect(this.target.port, this.target.host);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      this.sockets.add(from);
      from.on('data', chunk => { if (!this.stalled) to.write(chunk); });
      from.on('close', () => {
        this.sockets.delete(from);
        to.destroy();
      });
      from.on('error', () => { /* the close that follows ends the other side */ });
    }
  }
}

let container: StartedPostgreSqlContainer;
let direct: Pool;
let hop: Hop;
let backend: PostgresBackend;

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  hop = new Hop({ host: container.getHost(), port: container.getPort() });
  const port = await hop.listen();
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend({ url: `postgres://${user}:${password}@127.0.0.1:${port}/${container.getDatabase()}` });
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
});

afterAll(async () => {
  await backend?.stop();
  await hop?.close();
  await direct?.end();
  await container?.stop();
});

async function stored(guildId: string, filename: string): Promise<string | null> {
  const res = await direct.query(
    'SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3',
    [guildId, 'm', filename]);
  return res.rows[0]?.doc ?? null;
}

describe('a write ticket against a real Postgres', () => {
  it('answers held when the connection is cut mid-flush, and ok once the store is reachable again', async () => {
    const guildId = '424242';
    const token: FenceToken = { nodeId: 'node-a', claim: 1, shardId: 0, shardCount: 1 };
    const ws = new WorkingSetManager(backend);
    try {
      expect(await ws.hydrate(guildId, token)).toBe('ready');
      expect(ws.save(guildId, 'm', 'a.json', '{"a":1}')).toBe('accepted');
      const ticket = ws.ticketFor(guildId);

      hop.stall();
      const cutMidFlush = ws.confirm(ticket, 15_000);
      await new Promise(resolve => { setTimeout(resolve, 500); });
      hop.cutAll();
      expect(await cutMidFlush).toBe('held');
      expect(await stored(guildId, 'a.json')).toBeNull();

      hop.restore();
      expect(await ws.confirm(ticket, 15_000)).toBe('ok');
      expect(await stored(guildId, 'a.json')).toBe('{"a":1}');
    } finally {
      ws.evict(guildId);
    }
  }, 60_000);

  it('answers the operator route held when the connection is cut mid-flush, and a repeat delete held while it stays cut; confirmWrite answers ok once the store is reachable again', async () => {
    const guildId = '424243';
    const token: FenceToken = { nodeId: 'node-a', claim: 1, shardId: 0, shardCount: 1 };
    const held = {
      ok: true,
      pending: true,
      note: 'it is not saved yet; this node retries while it serves this guild, and loses it if the bot stops or loses its database first',
    };
    const options = { guildId, category: 'm' };
    setBackendKind('postgres');
    const ws = initWorkingSet(backend);
    try {
      expect(await ws.hydrate(guildId, token)).toBe('ready');
      const kept = saveDataTracked('b.json', options, { b: 1 });
      if (kept.outcome !== 'saved') throw new Error(`the write was not accepted: ${kept.outcome}`);
      expect(await confirmWrite(kept.ticket, 15_000)).toBe('ok');
      expect(await stored(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));

      hop.stall();
      const cutMidFlush = applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' });
      await new Promise(resolve => { setTimeout(resolve, 500); });
      hop.cutAll();
      expect(await cutMidFlush).toEqual(held);
      expect(await stored(guildId, 'a.json')).toBeNull();

      const remove = { guildId, module: 'm', filename: 'b.json', op: 'delete' as const };
      expect(await applyOperatorDataWrite(remove)).toEqual(held);
      expect(await applyOperatorDataWrite(remove)).toEqual(held);
      expect(await stored(guildId, 'b.json')).toBe(JSON.stringify({ b: 1 }, null, 2));

      hop.restore();
      const saved = saveDataTracked('c.json', options, { c: 1 });
      if (saved.outcome !== 'saved') throw new Error(`the write was not accepted: ${saved.outcome}`);
      expect(await confirmWrite(saved.ticket, 15_000)).toBe('ok');
      expect(await stored(guildId, 'c.json')).toBe(JSON.stringify({ c: 1 }, null, 2));
      expect(await stored(guildId, 'a.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
      expect(await stored(guildId, 'b.json')).toBeNull();
    } finally {
      ws.evict(guildId);
    }
  }, 90_000);
});

describe('the claim fence on a real Postgres', () => {
  const urlFor = (database: string) => {
    const user = encodeURIComponent(container.getUsername());
    const password = encodeURIComponent(container.getPassword());
    return `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${database}`;
  };

  async function readyBackend(database = container.getDatabase()): Promise<PostgresBackend> {
    const b = new PostgresBackend({ url: urlFor(database) });
    b.start();
    const until = Date.now() + 60_000;
    while (b.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
    expect(b.connectionState().state).toBe('ready');
    return b;
  }

  const tokenOf = (claim: number, nodeId = 'node-a'): FenceToken => ({ nodeId, claim, shardId: 0, shardCount: 1 });
  const batchOf = (doc: string) => ({ upserts: [{ key: { module: 'm', filename: 'x.json' }, doc }], deletes: [], appends: [] });
  const ownerRow = async (guildId: string) => (await direct.query(
    'SELECT node_id, claim FROM smdb_data.guild_ownership WHERE guild_id = $1', [guildId])).rows[0];
  let guilds = 525000;

  it('a fresh database is provisioned at version 2, with claim_seq and a claim column in place of term and epoch', async () => {
    const version = await direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`);
    expect(version.rows[0].value).toBe('{"v":2}');
    const seq = await direct.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_data' AND c.relname = 'claim_seq' AND c.relkind = 'S'`);
    expect(seq.rowCount).toBe(1);
    const columns = await direct.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'smdb_data' AND table_name = 'guild_ownership'`);
    const names = columns.rows.map(r => r.column_name);
    expect(names).toContain('claim');
    expect(names).not.toContain('term');
    expect(names).not.toContain('epoch');
  });

  it.each([
    [1, 1, 'commits'],
    [1, 2, 'commits'],
    [2, 1, 'deposed'],
  ] as const)('a stored claim %i and a token claim %i: the flush %s', async (storedClaim, tokenClaim, answer) => {
    const guildId = String(++guilds);
    await direct.query(
      `INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ($1, 'node-stored', 0, $2, 1)`,
      [guildId, storedClaim]);
    const outcome = await backend.flushGuild(guildId, batchOf('{"x":1}'), tokenOf(tokenClaim));
    if (answer === 'commits') {
      expect(outcome).toEqual({ ok: true });
      expect(await stored(guildId, 'x.json')).toBe('{"x":1}');
      expect(await ownerRow(guildId)).toEqual({ node_id: 'node-a', claim: String(tokenClaim) });
    } else {
      expect(outcome).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-stored', claim: 2 } });
      expect(await stored(guildId, 'x.json')).toBeNull();
      expect(await ownerRow(guildId)).toEqual({ node_id: 'node-stored', claim: '2' });
    }
  });

  it('two processes on one guild: the higher claim hydrates, the lower one\'s flush and retire are deposed', async () => {
    const guildId = String(++guilds);
    const other = await readyBackend();
    try {
      expect((await other.hydrateGuild(guildId, tokenOf(2, 'node-b'))).ok).toBe(true);
      expect(await backend.flushGuild(guildId, batchOf('{"from":"a"}'), tokenOf(1))).toMatchObject({ ok: false, reason: 'deposed' });
      expect(await other.flushGuild(guildId, batchOf('{"from":"b"}'), tokenOf(2, 'node-b'))).toEqual({ ok: true });
      expect(await stored(guildId, 'x.json')).toBe('{"from":"b"}');
      expect(await backend.retireGuild(guildId, 'test', tokenOf(1))).toEqual({ ok: false, reason: 'deposed' });
      expect(await stored(guildId, 'x.json')).toBe('{"from":"b"}');
      const graveyard = await direct.query('SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = $1', [guildId]);
      expect(graveyard.rowCount).toBe(0);
      expect(await backend.hydrateGuild(guildId, tokenOf(1))).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: 2 } });
      expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: '2' });
    } finally {
      await other.stop();
    }
  });

  it('a guild retired and then served again keeps its fence row through the graveyard sweep', async () => {
    const guildId = String(++guilds);
    const other = await readyBackend();
    try {
      expect((await other.hydrateGuild(guildId, tokenOf(2, 'node-b'))).ok).toBe(true);
      expect(await other.retireGuild(guildId, 'test', tokenOf(2, 'node-b'))).toMatchObject({ ok: true });
      expect((await other.hydrateGuild(guildId, tokenOf(2, 'node-b'))).ok).toBe(true);
      expect(await other.flushGuild(guildId, batchOf('{"from":"b"}'), tokenOf(2, 'node-b'))).toEqual({ ok: true });
      expect(await other.listGuilds()).toContain(guildId);
      await other.sweepGraveyard(Date.now() + 86_400_000);
      expect(await ownerRow(guildId)).toEqual({ node_id: 'node-b', claim: '2' });
      expect(await backend.flushGuild(guildId, batchOf('{"from":"a"}'), tokenOf(1))).toMatchObject({ ok: false, reason: 'deposed' });
      expect(await stored(guildId, 'x.json')).toBe('{"from":"b"}');
    } finally {
      await other.stop();
    }
  });

  it('claims taken at once are distinct, and a take is above every stored claim', async () => {
    const other = await readyBackend();
    const claimOf = async (b: PostgresBackend) => {
      const answer = await b.takeClaim();
      return answer.outcome === 'claimed' ? answer.claim : null;
    };
    try {
      const taken = await Promise.all([claimOf(backend), claimOf(other), claimOf(backend), claimOf(other)]);
      expect(taken.every(c => typeof c === 'number' && c > 0)).toBe(true);
      expect(new Set(taken).size).toBe(taken.length);
      await direct.query(
        `INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ($1, 'node-stored', 0, 100, 1)`,
        [String(++guilds)]);
      expect(await claimOf(backend)).toBe(101);
      expect(await claimOf(other)).toBe(102);
    } finally {
      await other.stop();
    }
  });

  it('a database provisioned at version 1 is refused: no claim, no DDL, no restore, and no guild row changes', async () => {
    await direct.query('CREATE DATABASE smdb_v1');
    const first = await readyBackend('smdb_v1');
    await first.stop();
    const { Pool: PgPool } = await import('pg');
    const old = new PgPool({ connectionString: urlFor('smdb_v1'), max: 2 });
    try {
      await old.query(`ALTER TABLE smdb_data.guild_ownership DROP COLUMN claim`);
      await old.query(`ALTER TABLE smdb_data.guild_ownership ADD COLUMN term bigint NOT NULL DEFAULT 1, ADD COLUMN epoch bigint NOT NULL DEFAULT 1`);
      await old.query(`UPDATE smdb_data.meta SET value = '{"v":1}' WHERE key = 'schema_version'`);
      await old.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, shard_count) VALUES ('7', 'node-old', 0, 1)`);
      await old.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('7', 'm', 'x.json', '{"old":1}')`);
      await old.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ('8', 'm', 'y.json', 'doc', '{"gone":1}', 5, 'test')`);
      await old.query(`DROP SEQUENCE smdb_data.claim_seq`);
      const before = (await old.query(`SELECT doc, updated_at FROM smdb_data.guild_data WHERE guild_id = '7'`)).rows;

      const refused = new PostgresBackend({ url: urlFor('smdb_v1') });
      refused.start();
      try {
        const until = Date.now() + 60_000;
        while (refused.connectionState().state !== 'outage' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
        expect(refused.connectionState().state).toBe('outage');
        expect(await refused.takeClaim()).toEqual({ outcome: 'mismatch' });
        expect(await refused.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":1}' });
        expect(await refused.restoreGuild('8', 5, { nodeId: '', claim: null, shardId: 0, shardCount: 1 })).toEqual({ ok: false, reason: 'schema-mismatch' });
        expect((await old.query(`SELECT doc, updated_at FROM smdb_data.guild_data WHERE guild_id = '7'`)).rows).toEqual(before);
        expect((await old.query(`SELECT 1 FROM smdb_data.guild_data WHERE guild_id = '8'`)).rowCount).toBe(0);
        expect((await old.query(`SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = '8'`)).rowCount).toBe(1);
        const seq = await old.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_data' AND c.relname = 'claim_seq'`);
        expect(seq.rowCount).toBe(0);
      } finally {
        await refused.stop();
      }
    } finally {
      await old.end();
    }
  }, 120_000);
});
