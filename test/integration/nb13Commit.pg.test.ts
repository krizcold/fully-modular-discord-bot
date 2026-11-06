import { randomUUID } from 'crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { WorkingSetManager, type WsTicket } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { Hop } from '../helpers/hop';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB13 decisions 1 to 4 against a real Postgres: a COMMIT whose answer is missing is checked before anything is sent again.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let hop: Hop;
let backend: PostgresBackend;
let other: PostgresBackend;
let guilds = 737000;

const tokenOf = (claim: number): FenceToken => ({ nodeId: `node-${claim}`, claim, processId: `p-${claim}`, shardId: 0, shardCount: 100 + claim });
const A = tokenOf(1);
const B = tokenOf(2);

function urlFor(port: number, host = '127.0.0.1'): string {
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  return `postgres://${user}:${password}@${host}:${port}/${container.getDatabase()}`;
}

async function ready(b: PostgresBackend): Promise<void> {
  b.start();
  const until = Date.now() + 60_000;
  while (b.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(b.connectionState().state).toBe('ready');
}

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  hop = new Hop({ host: container.getHost(), port: container.getPort() });
  backend = new PostgresBackend({ url: urlFor(await hop.listen()) });
  await ready(backend);
  other = new PostgresBackend({ url: urlFor(container.getPort(), container.getHost()) });
  await ready(other);
  for (const claim of [1, 2]) {
    await direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
      VALUES ($1, 0, $2, $3, 'node', 'node', 'node', 30000, 30000) ON CONFLICT DO NOTHING`, [100 + claim, claim, `p-${claim}`]);
  }
}, 180_000);

afterAll(async () => {
  await backend?.stop();
  await other?.stop();
  await hop?.close();
  await direct?.end();
  await container?.stop();
});

beforeEach(() => {
  hop.restore();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

async function lines(guildId: string): Promise<WsTicket> {
  return (await direct.query('SELECT count(*)::int AS n FROM smdb_data.guild_append WHERE guild_id = $1', [guildId])).rows[0].n;
}

async function mark(guildId: string): Promise<{ last_flush: string | null } | undefined> {
  return (await direct.query('SELECT last_flush::text AS last_flush FROM smdb_data.guild_ownership WHERE guild_id = $1', [guildId])).rows[0];
}

function batchOf(): GuildFlushBatch {
  return { upserts: [], deletes: [], appends: [{ key: { module: 'm', filename: 's.jsonl' }, chunk: 'line\n' }], flushId: randomUUID() };
}

async function oneLine(ws: WorkingSetManager, guildId: string): Promise<WsTicket> {
  expect(await ws.hydrate(guildId, A)).toBe('ready');
  expect(ws.append(guildId, 'm', 's.jsonl', 'line\n')).toBe('accepted');
  return ws.ticketFor(guildId);
}

describe('a COMMIT whose answer is missing', () => {
  it('3.1 answer dropped after COMMIT: confirm answers ok after the check, one row, last_flush holds the batch id', async () => {
    const guildId = String(++guilds);
    const ws = new WorkingSetManager(backend);
    try {
      const ticket = await oneLine(ws, guildId);
      const seen = hop.armCommit('drop-answer');
      const answer = ws.confirm(ticket, 90_000);
      await seen;
      expect(await answer).toBe('pending');
      expect(await ws.confirm(ticket, 90_000)).toBe('ok');
      expect(await lines(guildId)).toBe(1);
      expect((await mark(guildId))?.last_flush).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      ws.evict(guildId);
    }
  }, 120_000);

  it('3.2 COMMIT dropped and both sides cut: the check answers not-landed and the resend lands once', async () => {
    const guildId = String(++guilds);
    const ws = new WorkingSetManager(backend);
    try {
      const ticket = await oneLine(ws, guildId);
      const seen = hop.armCommit('drop-commit');
      const answer = ws.confirm(ticket, 90_000);
      await seen;
      expect(await answer).toBe('pending');
      expect(await ws.confirm(ticket, 90_000)).toBe('ok');
      expect(await lines(guildId)).toBe(1);
    } finally {
      ws.evict(guildId);
    }
  }, 120_000);

  it('3.3 COMMIT held 2 s: the check waits on the lock and answers landed no earlier than the hold end', async () => {
    const guildId = String(++guilds);
    expect(await backend.hydrateGuild(guildId, A)).toMatchObject({});
    const batch = batchOf();
    const seen = hop.armCommit('hold', 2000);
    const flushing = backend.flushGuild(guildId, batch, A);
    await seen;
    const started = Date.now();
    const fate = await other.resolveFlush(guildId, batch.flushId!, 1, A);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(fate).toEqual({ fate: 'landed' });
    expect(await flushing).toEqual({ ok: true });
    expect(await lines(guildId)).toBe(1);
  }, 60_000);

  it('3.4 COMMIT dropped with the server side kept open: the check waits for the idle timeout, answers not-landed, the resend lands', async () => {
    const guildId = String(++guilds);
    const ws = new WorkingSetManager(backend);
    try {
      const ticket = await oneLine(ws, guildId);
      const seen = hop.armCommit('drop-keep-server');
      const started = Date.now();
      const answer = ws.confirm(ticket, 90_000);
      await seen;
      expect(await answer).toBe('pending');
      expect(await ws.confirm(ticket, 90_000)).toBe('ok');
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
      expect(await lines(guildId)).toBe(1);
    } finally {
      ws.evict(guildId);
    }
  }, 120_000);

  it.each([['drop-answer', 'landed', 1], ['drop-commit', 'not-landed', 0]] as const)(
    '3.5 a guild with no ownership row, %s: the check answers %s', async (mode, fate, rows) => {
      const guildId = String(++guilds);
      const batch = batchOf();
      const seen = hop.armCommit(mode);
      const flushing = backend.flushGuild(guildId, batch, A);
      await seen;
      expect(await flushing).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true });
      hop.restore();
      expect(await backend.resolveFlush(guildId, batch.flushId!, 1, A)).toEqual({ fate });
      expect(await lines(guildId)).toBe(rows);
      if (fate === 'not-landed') expect(await mark(guildId)).toBeUndefined();
    }, 60_000);

  it('3.6 takeover after the dropped answer: deposed with landed true, then landed null once the new owner flushed; the line is stored once', async () => {
    const guildId = String(++guilds);
    expect(await backend.hydrateGuild(guildId, A)).toMatchObject({});
    const batch = batchOf();
    const seen = hop.armCommit('drop-answer');
    const flushing = backend.flushGuild(guildId, batch, A);
    await seen;
    expect(await flushing).toMatchObject({ ok: false, commitUnanswered: true });
    expect(await other.hydrateGuild(guildId, B)).toMatchObject({});
    expect(await backend.resolveFlush(guildId, batch.flushId!, 1, A)).toMatchObject({ fate: 'deposed', landed: true });
    expect(await other.flushGuild(guildId, { upserts: [{ key: { module: 'm', filename: 'b.json' }, doc: '{}' }], deletes: [], appends: [], flushId: randomUUID() }, B)).toEqual({ ok: true });
    expect(await backend.resolveFlush(guildId, batch.flushId!, 1, A)).toMatchObject({ fate: 'deposed', landed: null });
    expect(await lines(guildId)).toBe(1);
  }, 60_000);

  it('3.6 through the working set: after the new owner flushed, the first ticket answers unavailable and the line is stored once', async () => {
    const guildId = String(++guilds);
    const ws = new WorkingSetManager(backend);
    try {
      const ticket = await oneLine(ws, guildId);
      const seen = hop.armCommit('drop-answer');
      const answer = ws.confirm(ticket, 90_000);
      await seen;
      hop.stall();
      expect(await other.hydrateGuild(guildId, B)).toMatchObject({});
      expect(await other.flushGuild(guildId, { upserts: [{ key: { module: 'm', filename: 'b.json' }, doc: '{}' }], deletes: [], appends: [], flushId: randomUUID() }, B)).toEqual({ ok: true });
      hop.restore();
      expect(await answer).toBe('pending');
      expect(await ws.confirm(ticket, 90_000)).toBe('unavailable');
      expect(await lines(guildId)).toBe(1);
    } finally {
      ws.evict(guildId);
    }
  }, 120_000);

  it('3.7 a fresh database is at the current schema version with a nullable last_flush uuid', async () => {
    const version = await direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`);
    expect(version.rows[0].value).toBe(JSON.stringify({ v: SCHEMA_VERSION }));
    const col = await direct.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'smdb_data' AND table_name = 'guild_ownership' AND column_name = 'last_flush'`);
    expect(col.rows[0]).toEqual({ data_type: 'uuid', is_nullable: 'YES' });
  });

  it('3.7 a store at version 3 is refused and no row changes', async () => {
    await direct.query(`UPDATE smdb_data.meta SET value = '{"v":3}' WHERE key = 'schema_version'`);
    const before = (await direct.query('SELECT count(*)::int AS n FROM smdb_data.guild_ownership')).rows[0].n;
    const third = new PostgresBackend({ url: urlFor(container.getPort(), container.getHost()) });
    third.start();
    try {
      expect(await third.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":3}' });
      expect((await direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`)).rows[0].value).toBe('{"v":3}');
      expect((await direct.query('SELECT count(*)::int AS n FROM smdb_data.guild_ownership')).rows[0].n).toBe(before);
    } finally {
      await third.stop();
      await direct.query(`UPDATE smdb_data.meta SET value = $1 WHERE key = 'schema_version'`, [JSON.stringify({ v: SCHEMA_VERSION })]);
    }
  }, 60_000);

  it.each([[false], [true]])('3.9 and 3.10 no ownership row and the COMMIT held 2 s (claim row released: %s): the check answers landed after the hold, one row, no deposed', async released => {
    const guildId = String(++guilds);
    const batch = batchOf();
    const alerts: unknown[] = [];
    other.onAlert(a => { alerts.push(a); });
    const seen = hop.armCommit('hold', 2000);
    const flushing = backend.flushGuild(guildId, batch, A);
    await seen;
    if (released) await direct.query('UPDATE smdb_data.shard_claims SET released = true WHERE shard_count = 101 AND shard_id = 0');
    try {
      const started = Date.now();
      expect(await other.resolveFlush(guildId, batch.flushId!, 1, A)).toEqual({ fate: 'landed' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
      expect(await flushing).toEqual({ ok: true });
      expect(await lines(guildId)).toBe(1);
      expect(JSON.stringify(alerts)).not.toContain('deposed');
    } finally {
      if (released) await direct.query('UPDATE smdb_data.shard_claims SET released = false WHERE shard_count = 101 AND shard_id = 0');
    }
  }, 60_000);
});
