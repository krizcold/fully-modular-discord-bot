import { randomUUID } from 'crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { deadlineIn } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { showEntry } from '../../src/utils/databaseAddress';
import { TIMINGS, startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { copyStore, entryOf, otherSessions, provision, setGeneration, sleep, startBot, type BotRun } from '../helpers/nb5Pg';
import { startPostgres } from '../helpers/postgres';

// NB5 section 8 [pg] test 5 (decisions 10 to 12): two databases A and W of one store, W given A's rows and then the
// higher generation. The real chooser's watch finds W, the step latches A, the move goes to W and the re-save puts the
// guild there in replace mode. The claims step answers true: W holds A's claim rows, so the existing claim's fence
// passes there (the re-take variants need NB4's shard layer, below).

const ADMIN = 'nb5-admin';
const STORE = 'store-nb5';
const G = '880000000000000501';
const P = { nodeId: 'node-a', claim: 40, processId: 'p-a', shardId: 0, shardCount: 1 };
let a: StartedPostgreSqlContainer;
let w: StartedPostgreSqlContainer;
let directA: Pool;
let directW: Pool;
let entryA: string;
let entryW: string;

type Run = BotRun;
let run: Run | null = null;

beforeAll(async () => {
  [a, w] = await Promise.all([startPostgres(), startPostgres()]);
  entryA = entryOf(a);
  entryW = entryOf(w);
  directA = new Pool({ connectionString: entryA, application_name: ADMIN, max: 4 });
  directW = new Pool({ connectionString: entryW, application_name: ADMIN, max: 4 });
}, 240_000);
afterAll(async () => {
  await directA?.end();
  await directW?.end();
  await Promise.all([a?.stop(), w?.stop()]);
});
beforeEach(async () => {
  for (const pool of [directA, directW]) {
    await pool.query('DROP SCHEMA IF EXISTS smdb_data CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS smdb_manager CASCADE');
  }
  await provision(entryA, directA, STORE);
  await provision(entryW, directW, STORE);
  await setGeneration(directA, 'node-a', 1);
  await directA.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 40, 'p-a', 'node-a', 'node-a', 'node-a', 30000, 30000)`);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await run?.stop();
  run = null;
  vi.restoreAllMocks();
});

/** The bot process on A: the real chooser over the list, the backend, the working set and the move's steps. */
async function start(recordedStore = STORE): Promise<Run> {
  return (run = await startBot([entryA], recordedStore));
}

async function until(check: () => Promise<boolean> | boolean, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
    await sleep(250);
  }
}

/** The leave's saves, which drive the re-save (the leave itself is maintenance.ts's, not wired here). */
const resave = (r: Run) => r.ws.flushAllDirty().catch(() => undefined);

const liveDocs = async (pool: Pool, guildId = G) =>
  Object.fromEntries((await pool.query(`SELECT filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 ORDER BY filename`, [guildId])).rows.map(r => [r.filename, r.doc]));
const graves = async (pool: Pool, guildId = G) =>
  (await pool.query(`SELECT filename, kind, reason, retired_at::text AS batch FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 ORDER BY filename`, [guildId])).rows;

/** G on A: d2 and d3 saved; then W given A's rows, W's d2 set older, W raised to 2; then d3 deleted on A and d1 saved. */
async function seedSwitch(r: Run, beforeList: () => Promise<unknown> = async () => undefined): Promise<void> {
  expect(await r.ws.hydrate(G, P)).toBe('ready');
  r.ws.save(G, 'm', 'd2.json', '"new"');
  r.ws.save(G, 'm', 'd3.json', '"gone-on-a"');
  await r.ws.flushAllDirty();
  expect(await liveDocs(directA)).toEqual({ 'd2.json': '"new"', 'd3.json': '"gone-on-a"' });
  await copyStore(directA, directW);
  await directW.query(`UPDATE smdb_data.guild_data SET doc = '"old"' WHERE guild_id = $1 AND filename = 'd2.json'`, [G]);
  await setGeneration(directW, 'node-w', 2);
  expect(r.ws.delete(G, 'm', 'd3.json')).not.toBe('absent');
  await r.ws.flushAllDirty();
  r.ws.save(G, 'm', 'd1.json', '"dirty"');
  await beforeList();
  r.list = [entryA, entryW];
  r.chooser.confirmNow();
}

describe('the step and the move to W', () => {
  it('latches A (nothing more reaches A), moves to W, saves G there, puts the row G no longer has in one graveyard batch, and asks for the restart', async () => {
    const r = await start();
    await seedSwitch(r);
    await until(() => r.backend.latchReason() !== null);
    const aAtLatch = await liveDocs(directA);
    await until(() => r.moved.length === 1);
    expect(r.moved).toEqual([entryW]);
    await until(async () => { await resave(r); return (await liveDocs(directW))['d1.json'] === '"dirty"' && r.ws.resaveGuilds().length === 0; });
    expect(await liveDocs(directW)).toEqual({ 'd1.json': '"dirty"', 'd2.json': '"new"' });
    const moved = await graves(directW);
    expect(moved.map(g => g.filename)).toEqual(['d3.json']);
    expect(moved[0].reason).toBe(`re-saved by bot process ${P.processId} after it stopped writing to ${showEntry(entryA)}; these rows were not in its copy of the guild`);
    expect(await liveDocs(directA)).toEqual(aAtLatch);
    expect(await otherSessions(directA, ADMIN)).toBe(0);
    expect(r.leaves).toHaveLength(1);
  }, 180_000);

  it('a graveyard batch of G on W 60 s ahead of the clock: the re-save batch is that batch plus 1 (G4)', async () => {
    const r = await start();
    await seedSwitch(r);
    const ahead = Date.now() + 60_000;
    await directW.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', 'old.json', 'doc', '"x"', $2, 'earlier')`, [G, ahead]);
    await until(() => r.moved.length === 1);
    await until(async () => { await resave(r); return r.ws.resaveGuilds().length === 0 && (await graves(directW)).some(g => g.filename === 'd3.json'); });
    const d3 = (await graves(directW)).find(g => g.filename === 'd3.json')!;
    expect(Number(d3.batch)).toBe(ahead + 1);
  }, 180_000);

  it('W with another store id: the watch does not count W, so no latch and nothing is written on W (F5, decision 10)', async () => {
    const r = await start();
    let wBefore: Record<string, string> = {};
    await seedSwitch(r, async () => {
      await directW.query(`UPDATE smdb_data.meta SET value = $1 WHERE key = 'store_id'`, [JSON.stringify('another-store')]);
      wBefore = await liveDocs(directW);
    });
    await sleep(15_000);
    expect(r.backend.latchReason()).toBeNull();
    expect(r.moved).toEqual([]);
    expect(await liveDocs(directW)).toEqual(wBefore);
    expect(await graves(directW)).toEqual([]);
  }, 180_000);

  it("W at another schema version: the move's check refuses W, the latch and the held writes stay, the line logged once (F5 (a))", async () => {
    const r = await start();
    await seedSwitch(r, () => directW.query(`UPDATE smdb_data.meta SET value = '999' WHERE key = 'schema_version'`));
    await until(() => r.backend.latchReason() !== null);
    await sleep(15_000);
    expect(r.moved).toEqual([]);
    expect(r.backend.latchReason()).not.toBeNull();
    expect(r.ws.resaveGuilds()).toEqual([G]);
    expect((await liveDocs(directW))['d1.json']).toBeUndefined();
    const refusals = vi.mocked(console.error).mock.calls.map(c => String(c[0])).filter(line => line.startsWith(`[Database] Not moving to ${showEntry(entryW)}: the database holds schema version 999`));
    expect(refusals).toHaveLength(1);
  }, 180_000);

  it('a set clean at the latch whose document W lacks: no restart before the move, and the document is on W after it (R2-RUN-1)', async () => {
    const r = await start();
    expect(await r.ws.hydrate(G, P)).toBe('ready');
    await copyStore(directA, directW);
    r.ws.save(G, 'm', 'late.json', '"only-on-a"');
    await r.ws.flushAllDirty();
    expect((await liveDocs(directA))['late.json']).toBe('"only-on-a"');
    await setGeneration(directW, 'node-w', 2);
    r.list = [entryA, entryW];
    await until(() => r.backend.latchReason() !== null);
    expect(r.ws.resaveGuilds()).toEqual([G]);
    await until(() => r.moved.length === 1);
    await until(async () => { await resave(r); return (await liveDocs(directW))['late.json'] === '"only-on-a"'; });
  }, 180_000);
});

describe("round 5: a guild retired on A after W was given A's rows (NB5-R5-RESAVE-DELETES-RETIRED-ROWS)", () => {
  const R = '880000000000000502';
  const appendRows = async (pool: Pool, guildId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId])).rows[0].n;

  it("the re-save leaves W no live row of R, one graveyard batch of its 40 documents and the joined append file (41 rows), and NB11's restore brings them back", async () => {
    const r = await start();
    expect(await r.ws.hydrate(R, P)).toBe('ready');
    for (let i = 0; i < 40; i++) r.ws.save(R, 'm', `d${String(i).padStart(2, '0')}.json`, `"${i}"`);
    expect(r.ws.append(R, 'm', 'log.jsonl', 'line-1\n')).toBeTruthy();
    expect(r.ws.append(R, 'm', 'log.jsonl', 'line-2\n')).toBeTruthy();
    await r.ws.flushAllDirty();
    await copyStore(directA, directW);
    expect(await r.backend.retireGuild(R, 'test', P)).toMatchObject({ ok: true });
    r.ws.dropRetired(R);
    expect(await r.ws.hydrate(R, P)).toBe('ready');
    await setGeneration(directW, 'node-w', 2);
    r.list = [entryA, entryW];
    r.chooser.confirmNow();
    await until(() => r.moved.length === 1);
    await until(async () => { await resave(r); return r.ws.resaveGuilds().length === 0; });
    expect(await liveDocs(directW, R)).toEqual({});
    expect(await appendRows(directW, R)).toBe(0);
    const batch = await graves(directW, R);
    expect(new Set(batch.map(g => g.batch)).size).toBe(1);
    expect(batch.filter(g => g.kind === 'doc')).toHaveLength(40);
    expect(batch.filter(g => g.kind === 'append').map(g => g.filename)).toEqual(['log.jsonl']);
    const joined = await directW.query(`SELECT doc FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND kind = 'append'`, [R]);
    expect(joined.rows[0].doc).toBe('line-1\nline-2\n');
    const counted = vi.mocked(console.log).mock.calls.map(c => String(c[0]))
      .filter(line => line.startsWith(`[Data] Guild ${R}: the re-save on ${showEntry(entryW)} moved 41 row(s)`));
    expect(counted).toHaveLength(1);
    expect(await r.backend.restoreGuild(R, null, P, () => null, deadlineIn(60_000))).toMatchObject({ ok: true, copied: 41 });
    const kept = await directW.query(`SELECT count(*)::int AS n, count(used_at)::int AS used FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at::text = $2`, [R, batch[0].batch]);
    expect(kept.rows[0]).toEqual({ n: 41, used: 41 });
    expect(Object.keys(await liveDocs(directW, R))).toHaveLength(40);
    const lines = await directW.query(`SELECT string_agg(chunk, '' ORDER BY seq) AS text FROM smdb_data.guild_append WHERE guild_id = $1`, [R]);
    expect(lines.rows[0].text).toBe('line-1\nline-2\n');
  }, 240_000);
});

describe("decision 12 (d) as D2 amends it: the move's re-take on a real target (ClaimStore.retake on pgClaimRig)", () => {
  const ME = { processId: 'p-a', nodeId: 'node-a', nodeName: 'node-a' };
  const HELD = { shardCount: 1, shardId: 0, claim: 40 };
  let rig: ClaimRig;

  const request = () => ({ me: ME, shardCount: 1, pairs: [HELD], guildIds: [{ shardId: 0, guildIds: [G] }], generation: 2, ttlMs: TIMINGS.ttlMs });
  const shardRow = (count: number, claim: number, holder: string) => rig.direct.query(
    `INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
     VALUES ($1, 0, $2, $3, $4, $4, $4, 30000, 30000)`, [count, claim, holder, holder.replace(/^p-/, 'node-')]);
  const guildRow = (guildId: string, shardId: number, claim: number, node: string) => rig.direct.query(
    `INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ($1, $2, $3, $4, 1)`, [guildId, node, shardId, claim]);
  const flush = (claim: number) => rig.backend.flushGuild(G, {
    upserts: [{ key: { module: 'm', filename: 'retake.json' }, doc: `"${claim}"` }], deletes: [], appends: [], flushId: randomUUID(),
  }, { ...P, claim });
  const rows = async () => (await rig.direct.query(
    `SELECT shard_count, claim::text AS claim, holder_process FROM smdb_data.shard_claims ORDER BY shard_count, claim`)).rows;

  beforeAll(async () => { rig = await startClaimRig(); }, 240_000);
  afterAll(async () => { await rig?.stop(); });
  beforeEach(async () => {
    await rig.reset();
    await rig.direct.query('DELETE FROM smdb_data.guild_ownership');
    await rig.direct.query('DELETE FROM smdb_data.guild_data');
    await setGeneration(rig.direct, 'node-w', 2);
  });

  it("(a) the shard row names Y at 57 above P's 40 and G's row is stamped by Y at 57: no take, nothing changes, G's writes are refused deposed", async () => {
    await shardRow(1, 57, 'p-y');
    await guildRow(G, 0, 57, 'node-y');
    expect(await rig.store().retake(request())).toEqual({ taken: [] });
    expect(await rows()).toEqual([{ shard_count: 1, claim: '57', holder_process: 'p-y' }]);
    expect(await flush(40)).toMatchObject({ ok: false, reason: 'deposed' });
    const owner = await rig.direct.query(`SELECT claim::text AS claim, node_id FROM smdb_data.guild_ownership WHERE guild_id = $1`, [G]);
    expect(owner.rows).toEqual([{ claim: '57', node_id: 'node-y' }]);
  }, 120_000);

  it('(b) the shard count changed before the promotion (rows under count 2, none under 1): no take', async () => {
    await shardRow(2, 30, 'p-y');
    await guildRow(G, 0, 40, 'node-a');
    expect(await rig.store().retake(request())).toEqual({ taken: [] });
    expect(await rows()).toEqual([{ shard_count: 2, claim: '30', holder_process: 'p-y' }]);
  }, 120_000);

  it("(c) the shard row names another process below P's claim: no take, and G's writes are refused deposed", async () => {
    await shardRow(1, 12, 'p-y');
    await guildRow(G, 0, 40, 'node-a');
    expect(await rig.store().retake(request())).toEqual({ taken: [] });
    expect(await rows()).toEqual([{ shard_count: 1, claim: '12', holder_process: 'p-y' }]);
    expect(await flush(40)).toMatchObject({ ok: false, reason: 'deposed' });
  }, 120_000);

  it('a missing shard row with no guild row above the held claim: taken again under a claim above every claim on the target, and G saves', async () => {
    await guildRow(G, 0, 40, 'node-a');
    await guildRow('880000000000000503', 3, 90, 'node-z');
    const answer = await rig.store().retake(request());
    expect(answer.taken).toHaveLength(1);
    const claim = answer.taken[0].pair.claim;
    expect(claim).toBeGreaterThan(90);
    expect(await flush(claim)).toEqual({ ok: true });
  }, 120_000);

  it("D2: an earlier attempt's re-take committed and its answer discarded: the next attempt takes it again, G saves, nothing reads deposed", async () => {
    await guildRow(G, 0, 40, 'node-a');
    const store = rig.store();
    const first = await store.retake(request());
    expect(first.taken).toHaveLength(1);
    const second = await store.retake(request());
    expect(second.taken).toHaveLength(1);
    const claim = second.taken[0].pair.claim;
    expect(claim).toBeGreaterThan(first.taken[0].pair.claim);
    expect(await rows()).toEqual([{ shard_count: 1, claim: String(claim), holder_process: 'p-a' }]);
    expect(await flush(claim)).toEqual({ ok: true });
    expect(vi.mocked(console.error).mock.calls.map(c => String(c[0])).filter(line => line.includes('deposed'))).toEqual([]);
  }, 120_000);
});
