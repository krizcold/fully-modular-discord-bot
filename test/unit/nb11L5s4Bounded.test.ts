import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, RestoreOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';

// NB11 (wip-redesign/sheets/NB11.md): the bounded retire and restore transactions on Postgres, over a small in-memory
// stand-in for the tables they touch and a clock the test moves, so each floor is hit to the millisecond.

const G = '123456789012345678';
const OTHER = '876543210987654321';
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 };

type Doc = { guild: string; module: string; filename: string; doc: string };
type Chunk = { guild: string; module: string; filename: string; seq: number; chunk: string };
type Grave = { guild: string; module: string; filename: string; kind: 'doc' | 'append'; doc: string; retiredAt: number; reason: string; usedAt?: number };
type Owner = { nodeId: string; claim: number; retired: boolean };
type Tables = { data: Doc[]; append: Chunk[]; grave: Grave[]; owners: Map<string, Owner> };
type Result = { rows: Record<string, unknown>[]; rowCount: number | null };

let now = 1_000_000_000_000n;
const advance = (ms: number) => { now += BigInt(ms) * 1_000_000n; };
const deadlineIn = (ms: number) => now + BigInt(ms) * 1_000_000n;

function pgError(code: string, message: string, severity = 'ERROR'): Error {
  return Object.assign(new Error(message), { code, severity });
}

const copy = (t: Tables): Tables => ({
  data: t.data.map(r => ({ ...r })),
  append: t.append.map(r => ({ ...r })),
  grave: t.grave.map(r => ({ ...r })),
  owners: new Map([...t.owners].map(([k, v]) => [k, { ...v }])),
});

/**
 * A provisioned backend whose one pooled client runs the retire's and restore's statements against in-memory tables,
 * with transactions (a ROLLBACK puts the BEGIN snapshot back) and pg's bind check (a statement given a different
 * number of values than its placeholders fails with 08P01). `hook` runs first for each statement and may move the clock
 * or answer instead.
 */
function rig(opts: { foreignOwner?: { nodeId: string; claim: number }; hook?: (sql: string) => Error | void; onConnect?: () => void } = {}) {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  const internals = backend as unknown as { state: string; provisioned: boolean };
  internals.state = 'ready';
  internals.provisioned = true;
  let db: Tables = { data: [], append: [], grave: [], owners: new Map() };
  if (opts.foreignOwner) db.owners.set(G, { ...opts.foreignOwner, retired: false });
  let snapshot: Tables | null = null;
  let inTx = false;
  const statements: string[] = [];
  const releases: { destroy: boolean | undefined; openTransaction: boolean }[] = [];

  const run = (sql: string, values: unknown[]): Result => {
    const wanted = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    if (values.length !== wanted) throw pgError('08P01', `bind message supplies ${values.length} parameters, but prepared statement "" requires ${wanted}`);
    const [g, b] = values as [string, unknown];
    if (sql === '') return { rows: [], rowCount: null };
    if (sql === 'BEGIN') { snapshot = copy(db); inTx = true; return { rows: [], rowCount: null }; }
    if (sql === 'COMMIT') { snapshot = null; inTx = false; return { rows: [], rowCount: null }; }
    if (sql === 'ROLLBACK') { if (snapshot) db = snapshot; snapshot = null; inTx = false; return { rows: [], rowCount: null }; }
    if (/^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) {
      const owner = db.owners.get(g);
      if (owner && owner.claim > (values[3] as number)) return { rows: [], rowCount: 0 };
      db.owners.set(g, { nodeId: values[1] as string, claim: values[3] as number, retired: false });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO smdb_data\.guild_ownership/.test(sql)) {
      if (db.owners.has(g)) return { rows: [], rowCount: 0 };
      db.owners.set(g, { nodeId: values[1] as string, claim: values[3] as number, retired: false });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(sql)) {
      const owner = db.owners.get(g);
      return owner ? { rows: [{ node_id: owner.nodeId, claim: String(owner.claim) }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/pg_advisory_xact_lock_shared/.test(sql)) return { rows: [{}], rowCount: 1 };
    if (/^WITH r AS/.test(sql)) {
      const mine = db.grave.filter(r => r.guild === g).map(r => r.retiredAt);
      const at = Math.max(Date.now(), ...mine.map(x => x + 1));
      const groups = new Map<string, Chunk[]>();
      for (const c of db.append.filter(r => r.guild === g)) {
        const k = `${c.module}|${c.filename}`;
        groups.set(k, [...(groups.get(k) ?? []), c]);
      }
      for (const list of groups.values()) {
        const doc = list.sort((x, y) => x.seq - y.seq).map(c => c.chunk).join('');
        db.grave.push({ guild: g, module: list[0].module, filename: list[0].filename, kind: 'append', doc, retiredAt: at, reason: b as string });
      }
      const docs = db.data.filter(r => r.guild === g);
      for (const r of docs) db.grave.push({ ...r, kind: 'doc', retiredAt: at, reason: b as string });
      db.data = db.data.filter(r => r.guild !== g);
      db.append = db.append.filter(r => r.guild !== g);
      return { rows: [{ at: String(at), docs: String(docs.length), streams: String(groups.size), put: String(docs.length + groups.size) }], rowCount: 1 };
    }
    if (sql === 'UPDATE smdb_data.guild_ownership SET retired_at = now() WHERE guild_id = $1') {
      const owner = db.owners.get(g);
      if (owner) owner.retired = true;
      return { rows: [], rowCount: owner ? 1 : 0 };
    }
    if (/max\(retired_at\)/.test(sql)) {
      const mine = db.grave.filter(r => r.guild === g).map(r => r.retiredAt);
      return { rows: [{ retired_at: mine.length ? String(Math.max(...mine)) : null }], rowCount: 1 };
    }
    if (/^SELECT 1 FROM smdb_data\.guild_data_graveyard WHERE guild_id = \$1 AND retired_at = \$2/.test(sql)) {
      const found = db.grave.some(r => r.guild === g && r.retiredAt === Number(b));
      return found ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/AS present$/.test(sql)) {
      const present = db.data.some(r => r.guild === g) || db.append.some(r => r.guild === g);
      return { rows: [{ present }], rowCount: 1 };
    }
    if (/^WITH src AS/.test(sql)) {
      const moved = db.grave.filter(r => r.guild === g && r.retiredAt === Number(b));
      let seq = 1000;
      for (const r of moved) {
        r.usedAt = 1000;
        if (r.kind === 'doc') db.data.push({ guild: r.guild, module: r.module, filename: r.filename, doc: r.doc });
        else db.append.push({ guild: r.guild, module: r.module, filename: r.filename, seq: seq++, chunk: r.doc });
      }
      const reasons = moved.map(r => r.reason).sort();
      return { rows: [{ taken: String(moved.length), put: String(moved.length), reason: reasons.length ? reasons[0] : null, used_at: moved.length ? '1000' : null }], rowCount: 1 };
    }
    throw new Error(`[Test] Unscripted statement: ${sql}`);
  };

  const client = {
    query: async (config: string | { text: string; values?: unknown[] }) => {
      const sql = (typeof config === 'string' ? config : config.text).trim();
      const values = typeof config === 'string' ? [] : config.values ?? [];
      statements.push(sql);
      const hooked = opts.hook?.(sql);
      if (hooked instanceof Error) throw hooked;
      return run(sql, values);
    },
    release: (destroy?: boolean) => { releases.push({ destroy, openTransaction: inTx }); },
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = async () => { opts.onConnect?.(); return client; };
  return { backend, internals, statements, releases, tables: () => db, seed: (fn: (t: Tables) => void) => fn(db) };
}

/** Whether every client went back to the pool fit for reuse: destroyed, or with no transaction left open. */
const noOpenTransactionReturned = (releases: { destroy: boolean | undefined; openTransaction: boolean }[]) =>
  releases.every(r => r.destroy === true || !r.openTransaction);

function seedLive(t: Tables): void {
  t.data.push({ guild: G, module: 'm', filename: 'a.json', doc: '{"a":1}' }, { guild: G, module: 'm', filename: 'b.json', doc: '{"b":2}' });
  t.append.push({ guild: G, module: 'm', filename: 'log.jsonl', seq: 1, chunk: 'one\n' }, { guild: G, module: 'm', filename: 'log.jsonl', seq: 2, chunk: 'two\n' });
  t.data.push({ guild: OTHER, module: 'm', filename: 'a.json', doc: '{"other":true}' });
  t.append.push({ guild: OTHER, module: 'm', filename: 'log.jsonl', seq: 1, chunk: 'other\n' });
}

function seedGrave(t: Tables, retiredAt: number, reason: string, docs: Record<string, string>): void {
  for (const [filename, doc] of Object.entries(docs)) t.grave.push({ guild: G, module: 'm', filename, kind: 'doc', doc, retiredAt, reason });
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retireGuild on Postgres', () => {
  it('moves every live doc and stream of the guild into one graveyard batch, empties its live tables and commits', async () => {
    const r = rig();
    r.seed(seedLive);
    const outcome = await r.backend.retireGuild(G, 'webui-operator-delete', token, deadlineIn(40_000));
    expect(outcome).toEqual({ ok: true, moved: 3, retiredAt: expect.any(Number) });
    const t = r.tables();
    expect(t.data.filter(x => x.guild === G)).toEqual([]);
    expect(t.append.filter(x => x.guild === G)).toEqual([]);
    expect(t.data.filter(x => x.guild === OTHER)).toHaveLength(1);
    expect(t.append.filter(x => x.guild === OTHER)).toHaveLength(1);
    const batch = t.grave.filter(x => x.guild === G);
    expect(batch.map(x => [x.filename, x.kind, x.doc]).sort()).toEqual([
      ['a.json', 'doc', '{"a":1}'], ['b.json', 'doc', '{"b":2}'], ['log.jsonl', 'append', 'one\ntwo\n'],
    ]);
    expect(new Set(batch.map(x => x.retiredAt)).size).toBe(1);
    expect(t.owners.get(G)?.retired).toBe(true);
    expect(r.statements.at(-1)).toBe('COMMIT');
    expect(r.releases).toEqual([{ destroy: undefined, openTransaction: false }]);
  });

  it('a deposed retire rolls its transaction back before the client goes back to the pool', async () => {
    const r = rig({ foreignOwner: { nodeId: 'node-b', claim: 9 } });
    r.seed(seedLive);
    const outcome = await r.backend.retireGuild(G, 'webui-operator-delete', token, deadlineIn(40_000));
    expect(outcome).toEqual({ ok: false, reason: 'deposed' });
    expect(r.statements.at(-1)).toBe('ROLLBACK');
    expect(noOpenTransactionReturned(r.releases)).toBe(true);
    expect(r.tables().data.filter(x => x.guild === G)).toHaveLength(2);
  });

  it('with between 1 s and 2 s left before COMMIT it rolls back, answers out-of-time and keeps every live row', async () => {
    const r = rig({ hook: sql => { if (sql.startsWith('UPDATE smdb_data.guild_ownership SET retired_at')) advance(3_500); } });
    r.seed(seedLive);
    const outcome = await r.backend.retireGuild(G, 'webui-operator-delete', token, deadlineIn(5_000));
    expect(outcome).toEqual({ ok: false, reason: 'out-of-time' });
    expect(r.statements.at(-1)).toBe('ROLLBACK');
    expect(r.statements).not.toContain('COMMIT');
    expect(r.releases).toEqual([{ destroy: undefined, openTransaction: false }]);
    expect(r.tables().data.filter(x => x.guild === G)).toHaveLength(2);
    expect(r.tables().grave).toEqual([]);
  });

  it('with exactly 2 s left before COMMIT it still commits', async () => {
    const r = rig({ hook: sql => { if (sql.startsWith('UPDATE smdb_data.guild_ownership SET retired_at')) advance(3_000); } });
    r.seed(seedLive);
    const outcome = await r.backend.retireGuild(G, 'webui-operator-delete', token, deadlineIn(5_000));
    expect(outcome).toEqual({ ok: true, moved: 3, retiredAt: expect.any(Number) });
    expect(r.statements.at(-1)).toBe('COMMIT');
    expect(r.tables().data.filter(x => x.guild === G)).toEqual([]);
  });

  it('out of time before BEGIN is sent: nothing is sent and the untouched client goes back to the pool for reuse', async () => {
    const r = rig({ onConnect: () => advance(600) });
    r.seed(seedLive);
    const outcome = await r.backend.retireGuild(G, 'webui-operator-delete', token, deadlineIn(1_500));
    expect(outcome).toEqual({ ok: false, reason: 'out-of-time' });
    expect(r.statements).toEqual([]);
    expect(r.releases).toEqual([{ destroy: undefined, openTransaction: false }]);
  });

  it('out of time after BEGIN: the client holding the open transaction is destroyed, never pooled', async () => {
    const r = rig({ hook: sql => { if (/^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) advance(600); } });
    r.seed(seedLive);
    const outcome = await r.backend.retireGuild(G, 'webui-operator-delete', token, deadlineIn(1_500));
    expect(outcome).toEqual({ ok: false, reason: 'out-of-time' });
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0].destroy).toBe(true);
    expect(noOpenTransactionReturned(r.releases)).toBe(true);
  });
});

describe('restoreGuild on Postgres', () => {
  const never = () => null;

  it('restores the newest batch, logs it and answers the rows moved and the batch reason', async () => {
    const r = rig();
    r.seed(t => {
      seedGrave(t, 1_000, 'older', { 'old.json': '{"old":1}' });
      seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}', 'b.json': '{"b":2}' });
    });
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(40_000));
    expect(outcome).toEqual({ ok: true, copied: 2, retiredAt: 2_000, reason: 'webui-operator-delete', usedAt: 1000 });
    expect(r.tables().data.map(x => [x.filename, x.doc]).sort()).toEqual([['a.json', '{"a":1}'], ['b.json', '{"b":2}']]);
    expect(r.tables().grave.map(x => [x.retiredAt, x.usedAt])).toEqual([[1_000, undefined], [2_000, 1000], [2_000, 1000]]);
    expect(log).toHaveBeenCalledWith(`[PostgresBackend] Guild ${G} restored from graveyard batch 2000; 2 row(s) copied in`);
    expect(r.releases).toEqual([{ destroy: undefined, openTransaction: false }]);
  });

  it('restores the given batch when retiredAt is named', async () => {
    const r = rig();
    r.seed(t => {
      seedGrave(t, 1_000, 'older', { 'old.json': '{"old":1}' });
      seedGrave(t, 2_000, 'newer', { 'a.json': '{"a":1}' });
    });
    const outcome = await r.backend.restoreGuild(G, 1_000, token, never, deadlineIn(40_000));
    expect(outcome).toEqual({ ok: true, copied: 1, retiredAt: 1_000, reason: 'older', usedAt: 1000 });
    expect(r.tables().data.map(x => x.filename)).toEqual(['old.json']);
    expect(r.tables().grave.map(x => [x.retiredAt, x.usedAt])).toEqual([[1_000, 1000], [2_000, undefined]]);
  });

  it('a deposed restore names the current owner and rolls back before pooling the client', async () => {
    const r = rig({ foreignOwner: { nodeId: 'node-b', claim: 9 } });
    r.seed(t => seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}' }));
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(40_000));
    expect(outcome).toEqual({ ok: false, reason: 'deposed', currentOwner: { nodeId: 'node-b', claim: 9 } });
    expect(r.statements).toContain('ROLLBACK');
    expect(noOpenTransactionReturned(r.releases)).toBe(true);
    expect(r.backend.connectionState().state).toBe('ready');
    expect(r.tables().grave).toHaveLength(1);
  });

  it('during the hold the restore is refused with nothing sent (NB5 decision 13, G12)', async () => {
    const r = rig();
    r.seed(t => seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}' }));
    r.internals.state = 'outage';
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(40_000));
    expect(outcome).toMatchObject({ ok: false, reason: 'held' });
    expect(r.statements).toEqual([]);
    expect(r.tables().grave).toHaveLength(1);
  });

  it('with exactly 1 s left at the start it still runs and answers what the database holds', async () => {
    const r = rig();
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(1_000));
    expect(outcome).toEqual({ ok: false, reason: 'no-entry' });
  });

  it('a no-entry answer the database gave rolls back', async () => {
    const r = rig();
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(40_000));
    expect(outcome).toEqual({ ok: false, reason: 'no-entry' });
    expect(r.statements.at(-1)).toBe('ROLLBACK');
    expect(r.backend.connectionState().state).toBe('ready');
  });

  it('with exactly 2 s left before COMMIT it still commits the restore', async () => {
    const r = rig({ hook: sql => { if (sql.startsWith('WITH src AS')) advance(3_000); } });
    r.seed(t => seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}' }));
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(5_000));
    expect(outcome).toEqual({ ok: true, copied: 1, retiredAt: 2_000, reason: 'webui-operator-delete', usedAt: 1000 });
    expect(r.tables().data.map(x => x.filename)).toEqual(['a.json']);
    expect(r.tables().grave.map(x => [x.retiredAt, x.usedAt])).toEqual([[2_000, 1000]]);
  });

  it('out of time before BEGIN is sent: nothing is sent and the untouched client goes back to the pool for reuse', async () => {
    const r = rig({ onConnect: () => advance(600) });
    r.seed(t => seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}' }));
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(1_500));
    expect(outcome).toEqual({ ok: false, reason: 'out-of-time' });
    expect(r.statements).toEqual([]);
    expect(r.releases).toEqual([{ destroy: undefined, openTransaction: false }]);
  });

  it('a statement that timed out at the deadline starts no hold (NB5 I5)', async () => {
    const r = rig({ hook: sql => (/AS present$/.test(sql) ? new Error('Query read timeout') : undefined) });
    r.seed(t => seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}' }));
    const outcome: RestoreOutcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(40_000));
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', timedOut: true });
    expect(r.backend.connectionState().state).toBe('ready');
    expect(r.tables().grave).toHaveLength(1);
  });

  it('a statement the database refused is an answer and starts no hold', async () => {
    const r = rig({ hook: sql => (sql.startsWith('WITH src AS') ? pgError('23505', 'duplicate key value violates unique constraint') : undefined) });
    r.seed(t => seedGrave(t, 2_000, 'webui-operator-delete', { 'a.json': '{"a":1}' }));
    const outcome = await r.backend.restoreGuild(G, null, token, never, deadlineIn(40_000));
    expect(outcome).toMatchObject({ ok: false, reason: 'refused', code: '23505' });
    expect(r.backend.connectionState().state).toBe('ready');
  });
});
