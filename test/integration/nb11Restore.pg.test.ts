import net from 'net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { deleteGuildNamespace, guildDataOpOf, saveDataTracked, setGuildDataBackend, setOwnerInfoProvider, loadData } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setBackendKind } from '../helpers/backendKind';
import { takeShard } from '../helpers/pgClaims';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB11 tests 5 (wip-redesign/sheets/NB11.md): the restore's fenced transaction, its one-statement move and its
// client-side bound, and the delete's bounded retire, against a real Postgres behind a TCP hop that can drop traffic.

class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private repliesStalled = false;
  private readonly upstreams = new Set<net.Socket>();
  private readonly crossed = new Set<net.Socket>();
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  /** Bytes in both directions are dropped, and a close is not passed on, as on a network that loses packets without a reset. */
  stall(): void {
    this.stalled = true;
    for (const socket of this.sockets) this.crossed.add(socket);
  }

  /** Only the server's bytes and closes are dropped: what the client sends still reaches the server. */
  stallReplies(): void {
    this.repliesStalled = true;
    for (const socket of this.sockets) this.crossed.add(socket);
  }

  /** A connection that lost bytes cannot go on, so each one open during the stall is reset. */
  restore(): void {
    this.stalled = false;
    this.repliesStalled = false;
    for (const socket of this.crossed) socket.destroy();
    this.crossed.clear();
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private dropping(from: net.Socket): boolean {
    return this.stalled || (this.repliesStalled && this.upstreams.has(from));
  }

  private accept(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    this.upstreams.add(upstream);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      this.sockets.add(from);
      if (this.stalled || this.repliesStalled) this.crossed.add(from);
      from.on('data', chunk => { if (!this.dropping(from)) to.write(chunk); });
      from.on('close', () => {
        this.sockets.delete(from);
        this.upstreams.delete(from);
        if (!this.dropping(from)) to.destroy();
      });
      from.on('error', () => { /* the close that follows ends the other side */ });
    }
  }
}

const LIVE = (g: string, r: number) => `server ${g} has data saved since entry ${r} was deleted; nothing was restored. To put entry ${r} in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${g} ${r} --replace`;
const DELETE_TIMEOUT = 'the database did not finish the delete within its 40 s; nothing was removed; try again in a moment';
const RESTORE_TIMEOUT = "[Data] The database did not answer or ended the connection (the database did not answer within the restore's 40 s); nothing was restored; try again in a moment";
const UNKNOWN = (g: string, r: number) => `can't confirm whether server ${g} was restored: the database did not confirm the commit; the outcome is fixed within a minute. Entry ${r} stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${g} ${r} --replace is then safe: it copies entry ${r} in and moves whatever the server holds into a new entry, so nothing is lost. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.`;
const SECOND = 1000;

let container: StartedPostgreSqlContainer;
let direct: Pool;
let hop: Hop;
let backend: PostgresBackend;
let claim: number;
let guilds = 910_000;

const freshGuild = () => String(++guilds);
const tokenOf = (c: number, nodeId = 'node-a'): FenceToken => ({ nodeId, claim: c, processId: 'process-a', shardId: 0, shardCount: 1 });
const none = () => null;
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  hop = new Hop({ host: container.getHost(), port: container.getPort() });
  const port = await hop.listen();
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend(fixedDatabase(`postgres://${user}:${password}@127.0.0.1:${port}/${container.getDatabase()}`));
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await sleep(100);
  expect(backend.connectionState().state).toBe('ready');
  claim = (await takeShard(direct, { processId: 'process-a', nodeId: 'node-a' })).claim!;
});

afterAll(async () => {
  driver?.stop();
  await hop?.close();
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

async function bury(guildId: string, retiredAt: number, docs: Record<string, string>, appends: Record<string, string> = {}): Promise<void> {
  for (const [filename, doc] of Object.entries(docs)) {
    await direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', $2, 'doc', $3, $4, 'test')`, [guildId, filename, doc, retiredAt]);
  }
  for (const [filename, chunk] of Object.entries(appends)) {
    await direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', $2, 'append', $3, $4, 'test')`, [guildId, filename, chunk, retiredAt]);
  }
}

const rows = async (sql: string, values: unknown[]) => (await direct.query(sql, values)).rows;
const liveDocs = (g: string) => rows(`SELECT filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 ORDER BY filename`, [g]);
const graveRows = (g: string) => rows(`SELECT filename, retired_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 ORDER BY filename`, [g]);

/**
 * Shows each statement a client of the backend's pool sends, before and after it is handed to the connection, until
 * the returned undo runs. pg's pool.query takes its client through connect's callback form, so both forms are wrapped.
 */
function watchStatements(seen: (text: string, handed: boolean) => void): () => void {
  const pool = backend.getPool() as any;
  const connect = pool.connect;
  const patched = new Map<any, any>();
  const patch = (client: any) => {
    if (!client || patched.has(client)) return;
    const query = client.query;
    patched.set(client, query);
    client.query = (config: any, ...rest: any[]) => {
      const text = typeof config === 'string' ? config : config?.text;
      if (typeof text === 'string') seen(text.trim(), false);
      const sent = query.call(client, config, ...rest);
      if (typeof text === 'string') seen(text.trim(), true);
      return sent;
    };
  };
  pool.connect = (...args: any[]) => {
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (callback) {
      return connect.call(pool, (error: unknown, client: any, done: unknown) => {
        if (!error) patch(client);
        callback(error, client, done);
      });
    }
    return connect.call(pool).then((client: any) => { patch(client); return client; });
  };
  return () => {
    pool.connect = connect;
    for (const [client, query] of patched) client.query = query;
  };
}

/** Calls act once, right after a statement matching match is handed to the connection. */
function onStatement(match: RegExp, act: () => void): () => void {
  let fired = false;
  return watchStatements((text, handed) => {
    if (handed && !fired && match.test(text)) {
      fired = true;
      setImmediate(act);
    }
  });
}

const openTransactions = async () => Number((await rows(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND (state LIKE 'idle in transaction%' OR (state = 'active' AND query LIKE 'WITH src AS%'))`, []))[0].n);

/** The server has ended the restore's transaction: no session is left in it, and no lock holds the guild's batch rows. */
async function serverEnded(g: string, openBefore: number): Promise<void> {
  expect(await openTransactions()).toBe(openBefore);
  const probe = await direct.connect();
  try {
    await probe.query('BEGIN');
    const locked = await probe.query(`SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 FOR UPDATE NOWAIT`, [g]);
    expect(locked.rowCount).toBe(1);
  } finally {
    await probe.query('ROLLBACK');
    probe.release();
  }
}

let driver: DataReadinessDriver | null = null;

/** The bot process's data stack over the real backend: a working set, the readiness driver and the owner info. */
async function stack(): Promise<{ ws: WorkingSetManager; driver: DataReadinessDriver }> {
  setBackendKind('postgres');
  setGuildDataBackend(backend);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: () => claim }));
  driver?.stop();
  const ws = initWorkingSet(backend);
  driver = initDataReadiness(backend, ws, { held: false });
  driver.onLeaseChanged({ nodeId: 'node-a', processId: 'process-a', claims: { 0: claim }, shardCount: 1, shardIds: [0] });
  await driver.awaitInitialHydration(20 * SECOND);
  return { ws, driver };
}

const restoreReq = (guildId: string, retiredAt?: number, sentMono = process.hrtime.bigint()) => ({
  guildId, module: '', filename: '', op: 'restore-graveyard' as const,
  contentJson: JSON.stringify({ retiredAt }),
  answerByMono: (sentMono + 45_000_000_000n).toString(),
});
const msSince = (sentMono: bigint) => Number(process.hrtime.bigint() - sentMono) / 1e6;

describe('the fence', () => {
  it('a stored claim above the restorer\'s answers deposed and changes nothing', async () => {
    const g = freshGuild();
    await direct.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ($1, 'node-b', 0, $2, 1)`, [g, claim + 1]);
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await backend.restoreGuild(g, null, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: claim + 1 } });
    expect(await liveDocs(g)).toEqual([]);
    expect(await graveRows(g)).toHaveLength(1);
  });

  it.each([['equal', 0], ['higher', 1]] as const)('a restorer\'s %s claim commits and stamps the ownership row', async (_name, below) => {
    const g = freshGuild();
    await direct.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count, retired_at) VALUES ($1, 'node-old', 0, $2, 1, now())`, [g, claim - below]);
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await backend.restoreGuild(g, null, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: true, copied: 1, retiredAt: 5, reason: 'test', usedAt: expect.any(Number) });
    const owner = (await rows(`SELECT node_id, claim, retired_at FROM smdb_data.guild_ownership WHERE guild_id = $1`, [g]))[0];
    expect(owner.node_id).toBe('node-a');
    expect(Number(owner.claim)).toBe(claim);
    expect(owner.retired_at).toBeNull();
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
    expect((await rows(`SELECT used_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = 5`, [g]))[0].used_at).not.toBeNull();
  });
});

describe('the live check and the batch', () => {
  it('live append rows only refuse the restore with the batch\'s retiredAt', async () => {
    const g = freshGuild();
    await direct.query(`INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, 'm', 'l.jsonl', 'x\n')`, [g]);
    await bury(g, 7, { 'a.json': '{"a":1}' });
    expect(await backend.restoreGuild(g, null, tokenOf(claim), none, monoIn(40 * SECOND))).toEqual({ ok: false, reason: 'live-rows', retiredAt: 7 });
    expect(await graveRows(g)).toHaveLength(1);
    expect(await liveDocs(g)).toEqual([]);
  });

  it('no retiredAt takes the newest batch; a batch swept first answers no-entry', async () => {
    const g = freshGuild();
    await bury(g, 5, { 'old.json': '{"o":1}' });
    await bury(g, 9, { 'new.json': '{"n":1}' });
    expect(await backend.restoreGuild(g, null, tokenOf(claim), none, monoIn(40 * SECOND))).toMatchObject({ ok: true, retiredAt: 9 });
    expect(await liveDocs(g)).toEqual([{ filename: 'new.json', doc: '{"n":1}' }]);
    const h = freshGuild();
    await bury(h, 5, { 'a.json': '{}' });
    await direct.query(`DELETE FROM smdb_data.guild_data_graveyard WHERE guild_id = $1`, [h]);
    expect(await backend.restoreGuild(h, 5, tokenOf(claim), none, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(await liveDocs(h)).toEqual([]);
  });

  it('a given retiredAt that names no batch answers no-entry on a guild with live rows, and nothing moves', async () => {
    const g = freshGuild();
    await direct.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, 'm', 'live.json', '{"l":1}')`, [g]);
    await bury(g, 1730000000000, { 'a.json': '{"a":1}' });
    expect(await backend.restoreGuild(g, 1730000000001, tokenOf(claim), none, monoIn(40 * SECOND))).toMatchObject({ ok: false, reason: 'no-entry' });
    expect(await liveDocs(g)).toEqual([{ filename: 'live.json', doc: '{"l":1}' }]);
    expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
  });
});

describe('through the real stack', () => {
  it('a write accepted before the restore is not dropped', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"old":1}' });
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    expect(saveDataTracked('b.json', { guildId: g, category: 'm' }, { b: 1 }).outcome).toBe('saved');
    expect(await applyOperatorDataWrite(restoreReq(g))).toEqual({ ok: false, code: 'invalid', refusal: 'live-data', retiredAt: 5, error: LIVE(g, 5) });
    expect(await liveDocs(g)).toEqual([{ filename: 'b.json', doc: JSON.stringify({ b: 1 }, null, 2) }]);
    expect(await graveRows(g)).toHaveLength(1);
  }, 60_000);

  it('after an ok, the read serves the restored docs and append lines in their order', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"a":1}' }, { 'l.jsonl': 'one\ntwo\n' });
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    expect(await applyOperatorDataWrite(restoreReq(g))).toEqual({ ok: true, retiredAt: 5, reason: 'test', copied: 2, keptUntil: expect.any(Number) });
    for (let i = 0; i < 50 && ws.stateOf(g) !== 'ready'; i++) await sleep(50);
    expect(loadData('a.json', { guildId: g, category: 'm' }, null)).toEqual({ a: 1 });
    expect(await rows(`SELECT chunk FROM smdb_data.guild_append WHERE guild_id = $1 ORDER BY seq`, [g])).toEqual([{ chunk: 'one\ntwo\n' }]);
  }, 60_000);

  it('a second restore of an entry already restored is refused as live data naming it, and the restored docs stay live', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    expect(await applyOperatorDataWrite(restoreReq(g, 5))).toEqual({ ok: true, retiredAt: 5, reason: 'test', copied: 1, keptUntil: expect.any(Number) });
    for (let i = 0; i < 50 && ws.stateOf(g) !== 'ready'; i++) await sleep(50);
    expect(await applyOperatorDataWrite(restoreReq(g, 5))).toEqual({ ok: false, code: 'invalid', refusal: 'live-data', retiredAt: 5, error: LIVE(g, 5) });
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
    expect((await rows(`SELECT used_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = 5`, [g]))[0].used_at).not.toBeNull();
  }, 60_000);

  it('a stall before COMMIT answers unavailable by 45 s, reopens the set, and the server rolls back', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    const openBefore = await openTransactions();
    const undo = onStatement(/^WITH src AS/, () => hop.stall());
    const sent = process.hrtime.bigint();
    try {
      const reply = await applyOperatorDataWrite(restoreReq(g, undefined, sent));
      expect(msSince(sent)).toBeLessThan(45 * SECOND);
      expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: RESTORE_TIMEOUT });
      expect(ws.stateOf(g)).toBe('ready');
      expect(guildDataOpOf(g)).toBeUndefined();
      await serverEnded(g, openBefore);
    } finally {
      undo();
      hop.restore();
    }
    await sleep(41 * SECOND);
    expect(await graveRows(g)).toHaveLength(1);
    expect(await liveDocs(g)).toEqual([]);
  }, 150_000);

  it('COMMIT lost on the way answers can\'t confirm by 45 s, evicts the set, and the server rolls back', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    const openBefore = await openTransactions();
    let armed = true;
    const undo = watchStatements((text, handed) => {
      if (!handed && armed && text === 'COMMIT') {
        armed = false;
        hop.stall();
      }
    });
    const evict = vi.spyOn(ws, 'evict');
    const sent = process.hrtime.bigint();
    try {
      const reply = await applyOperatorDataWrite(restoreReq(g, undefined, sent));
      expect(msSince(sent)).toBeLessThan(45 * SECOND);
      expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: UNKNOWN(g, 5) });
      expect(evict).toHaveBeenCalledWith(g);
      expect(ws.stateOf(g)).not.toBe('restoring');
      expect(ws.stateOf(g)).not.toBe('ready');
      await serverEnded(g, openBefore);
    } finally {
      undo();
      hop.restore();
    }
    expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
    expect(await liveDocs(g)).toEqual([]);
  }, 180_000);

  it('COMMIT that lands with its answer lost answers can\'t confirm, and the read after it serves the restored docs', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    await bury(g, 5, { 'a.json': '{"a":1}' });
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    const openBefore = await openTransactions();
    let armed = true;
    const undo = watchStatements((text, handed) => {
      if (!handed && armed && text === 'COMMIT') {
        armed = false;
        hop.stallReplies();
      }
    });
    const evict = vi.spyOn(ws, 'evict');
    const sent = process.hrtime.bigint();
    try {
      const reply = await applyOperatorDataWrite(restoreReq(g, undefined, sent));
      expect(msSince(sent)).toBeLessThan(45 * SECOND);
      expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: UNKNOWN(g, 5) });
      expect(evict).toHaveBeenCalledWith(g);
      expect(ws.stateOf(g)).not.toBe('restoring');
      expect(guildDataOpOf(g)).toBeUndefined();
      expect(await openTransactions()).toBe(openBefore);
      expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
      expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
      expect((await rows(`SELECT used_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = 5`, [g]))[0].used_at).not.toBeNull();
    } finally {
      undo();
      hop.restore();
    }
    const until = Date.now() + 45 * SECOND;
    let state: string | null = ws.stateOf(g);
    while (Date.now() < until && state !== 'ready') {
      state = await ws.hydrate(g, tokenOf(claim));
      if (state !== 'ready') await sleep(100);
    }
    expect(state).toBe('ready');
    expect(loadData('a.json', { guildId: g, category: 'm' }, null)).toEqual({ a: 1 });
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
    expect((await rows(`SELECT used_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = 5`, [g]))[0].used_at).not.toBeNull();
  }, 180_000);
});

describe('the delete through the real stack', () => {
  it('a hydrate kicked by an event while the retire is held does not serve the moved docs after the delete answers', async () => {
    const { ws, driver } = await stack();
    const g = freshGuild();
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    expect(saveDataTracked('a.json', { guildId: g, category: 'm' }, { a: 1 }).outcome).toBe('saved');
    expect(await ws.flushGuildNow(g, 5 * SECOND)).toBe('ok');
    ws.evict(g);
    const waitingOnLocks = async () => Number((await rows(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`, []))[0].n);
    const seen: unknown[] = [];
    const base = await waitingOnLocks();
    const lock = await direct.connect();
    try {
      await lock.query('BEGIN');
      await lock.query(`SELECT 1 FROM smdb_data.guild_ownership WHERE guild_id = $1 FOR UPDATE`, [g]);
      const deleting = deleteGuildNamespace(g, 'webui-operator-delete', 5 * SECOND, monoIn(40 * SECOND));
      expect(guildDataOpOf(g)).toBe('delete');
      for (let i = 0; i < 100 && await waitingOnLocks() < base + 1; i++) await sleep(50);
      expect(await waitingOnLocks()).toBe(base + 1);
      expect(ws.stateOf(g)).toBeNull();
      expect(driver.admitEvent(g, () => { seen.push(loadData('a.json', { guildId: g, category: 'm' }, null)); })).toBe(false);
      for (let i = 0; i < 100 && await waitingOnLocks() < base + 2; i++) await sleep(50);
      expect(await waitingOnLocks()).toBe(base + 2);
      await lock.query('COMMIT');
      expect(await deleting).toEqual({ ok: true });
    } finally {
      lock.release();
    }
    for (let i = 0; i < 200 && seen.length === 0; i++) await sleep(50);
    expect(seen).toEqual([null]);
    expect(ws.stateOf(g)).toBe('ready');
    expect(loadData('a.json', { guildId: g, category: 'm' }, null)).toBeNull();
    expect(await liveDocs(g)).toEqual([]);
    expect(await graveRows(g)).toEqual([{ filename: 'a.json', retired_at: expect.anything() }]);
  }, 60_000);

  it('a retire on a stalled connection answers by 45 s, and every row stays live', async () => {
    const { ws } = await stack();
    const g = freshGuild();
    expect(await ws.hydrate(g, tokenOf(claim))).toBe('ready');
    expect(saveDataTracked('a.json', { guildId: g, category: 'm' }, { a: 1 }).outcome).toBe('saved');
    expect(await ws.flushGuildNow(g, 5 * SECOND)).toBe('ok');
    const undo = onStatement(/^INSERT INTO smdb_data\.guild_ownership AS o\b/, () => hop.stall());
    const sent = process.hrtime.bigint();
    try {
      const reply = await applyOperatorDataWrite({ guildId: g, module: '', filename: '', op: 'delete-namespace', answerByMono: (sent + 45_000_000_000n).toString() });
      expect(msSince(sent)).toBeLessThan(45 * SECOND);
      expect(reply).toEqual({ ok: false, code: 'backend-unavailable', error: DELETE_TIMEOUT });
      expect(guildDataOpOf(g)).toBeUndefined();
    } finally {
      undo();
      hop.restore();
    }
    const until = Date.now() + 45 * SECOND;
    let state: string = 'unavailable';
    while (Date.now() < until && state !== 'ready') {
      state = await ws.hydrate(g, tokenOf(claim));
      if (state !== 'ready') await sleep(100);
    }
    expect(state).toBe('ready');
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: JSON.stringify({ a: 1 }, null, 2) }]);
  }, 150_000);
});
