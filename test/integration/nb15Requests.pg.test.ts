import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 10 on real Postgres: the op CHECK takes every NB15 op and refuses another; one claim statement takes data,
// action and read rows within their limits and empties their bodies; the start checks refuse a row whose guild is not
// on its shard and a system panel; a row past claim_by is never claimed; the cleanup empties unclaimed bodies and
// deletes answered rows after 2 minutes; the notifier's payload reaches a LISTEN; the test connections class as
// 'local' or 'verified'.
import {
  ACTION_OPS,
  CLEANUP_BODIES_SQL,
  CLEANUP_SQL,
  DATA_OPS,
  HOLDER_MAP_SQL,
  READ_OPS,
  REQUEST_CLAIM_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { holderStateOf } from '../../src/bot/internalSetup/fleet/claimStore';
import { GuildRequestSweep, type PanelHooks, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import { NOTIFY_SQL, PANEL_CHANNEL } from '../../src/bot/internalSetup/fleet/panelLive';
import { pgConfig, transportOf } from '../../src/utils/databaseAddress';
import { _pgRequestDbForTests, _resetGuildRequests, _setGuildRequestDeps, planGuildRequest, runGuildRequest, type PanelAnswer } from '../../src/webui/utils/guildRequests';
import { _resetPanelLive, _setNotifyDb, noteLiveChange, notifyTick, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { BOT_DOWN, heldRow } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { takeShard } from '../helpers/pgClaims';

const OWNER = { via: 'owner', userId: 'web-ui-owner' };
/** A guild of shard 1 of 2, and one of shard 0. */
const G1 = String(1n << 22n);
const G0 = String(2n << 22n);

let rig: ClaimRig;
const pools: Pool[] = [];

const sweepDb = (pool: Pool): SweepDb => ({ query: (text, values, boundMs) => pool.query({ text, values, query_timeout: boundMs } as any) });
function poolOf(): Pool {
  const pool = new Pool({ connectionString: rig.url, max: 4 });
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
}

beforeAll(async () => {
  rig = await startClaimRig();
  setBackendKind('postgres');
}, 180_000);

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  await rig?.stop();
});

beforeEach(async () => {
  setBackendKind('postgres');
  await rig.reset();
  await rig.direct.query('DELETE FROM smdb_data.guild_requests');
  await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});

async function insert(op: string, guildId: string, shardId: number, forProcess: string, body: unknown, claimBySecs = 5): Promise<string> {
  const id = randomUUID();
  await rig.direct.query(
    `INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by)
     VALUES ($1, $2, 2, $3, $4, $5, $6, 'ALPHA', now() + make_interval(secs => $7), now() + make_interval(secs => 30))`,
    [id, guildId, shardId, forProcess, op, JSON.stringify(body), claimBySecs]);
  return id;
}

function hooks(calls: string[]): PanelHooks {
  return {
    answerPanel: async (op, body) => { calls.push(`${op}:${String(body.panelId ?? '')}`); return op === 'guild:channels' ? { success: true, channels: [] } : { success: true, data: { v: 1 } }; },
    answerInvoke: async () => { calls.push('command:invoke'); return { success: true, ran: true }; },
    maintenanceRefusal: () => null,
    getPanel: id => (id === 'updateManager' ? { panelScope: 'system' } : { panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: ids => ({ success: true, guilds: ids.map(id => ({ id })) }),
    registerInterest: () => 1,
  };
}

const waitFor = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

describe('the schema', () => {
  it('takes every NB15 op and refuses another', async () => {
    for (const op of [...ACTION_OPS, ...READ_OPS]) await insert(op, G1, 1, 'p-b', { actor: OWNER });
    await expect(insert('panel:delete', G1, 1, 'p-b', {})).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the holder', () => {
  it('B claims and runs a request naming it, with one claim taking data, action and read rows and emptying their bodies; A never claims it', async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    const tokenA = await takeShard(rig.direct, { processId: 'p-a', nodeId: 'n-a', shardId: 0, shardCount: 2 });
    const button = await insert('panel:button', G1, 1, 'p-b', { panelId: 'p', buttonId: 'b', actor: OWNER });
    const read = await insert('guild:channels', G1, 1, 'p-b', { actor: OWNER });
    const pool = poolOf();
    const calls: string[] = [];
    const callsA: string[] = [];
    const sweepA = new GuildRequestSweep({ db: sweepDb(pool), processId: () => 'p-a', pairs: () => [{ shardCount: 2, shardId: 0, claim: Number(tokenA.claim) }], stoppedServing: () => false, isStopping: () => false, apply: async () => ({ ok: true }), panel: hooks(callsA) });
    await sweepA.pass();
    expect(callsA).toEqual([]);
    const claims: string[] = [];
    const sweepB = new GuildRequestSweep({
      db: { query: async (text, values, boundMs) => { if (text === REQUEST_CLAIM_SQL) claims.push(text); return pool.query({ text, values, query_timeout: boundMs } as any); } },
      processId: () => 'p-b', pairs: () => [{ shardCount: 2, shardId: 1, claim: Number(tokenB.claim) }], stoppedServing: () => false, isStopping: () => false, apply: async () => ({ ok: true }), panel: hooks(calls),
    });
    await sweepB.pass();
    expect(claims).toHaveLength(1);
    await waitFor(async () => (await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_requests WHERE state = 'done'`)).rows[0].n === 2);
    const rows = (await rig.direct.query(`SELECT id, body, state, reply FROM smdb_data.guild_requests ORDER BY created_at`)).rows;
    expect(rows.every(r => r.body === '')).toBe(true);
    expect(JSON.parse(rows.find(r => r.id === button).reply)).toEqual({ success: true, data: { v: 1 }, liveSince: 1, liveVersion: 0 });
    expect(JSON.parse(rows.find(r => r.id === read).reply)).toEqual({ success: true, channels: [] });
    expect(calls).toEqual(['panel:button:p', 'guild:channels:']);
    expect(DATA_OPS.length).toBe(4);
  });

  it("a row whose guild is shard 0's but names shard 1 answers invalid; a system panel as web-ui-owner not-allowed; a row past claim_by never runs", async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    const wrong = await insert('panel:button', G0, 1, 'p-b', { panelId: 'p', buttonId: 'b', actor: OWNER });
    const system = await insert('panel:execute', G1, 1, 'p-b', { panelId: 'updateManager', actor: OWNER });
    const late = await insert('panel:execute', G1, 1, 'p-b', { panelId: 'p', actor: OWNER }, -1);
    const calls: string[] = [];
    const sweep = new GuildRequestSweep({ db: sweepDb(poolOf()), processId: () => 'p-b', pairs: () => [{ shardCount: 2, shardId: 1, claim: Number(tokenB.claim) }], stoppedServing: () => false, isStopping: () => false, apply: async () => ({ ok: true }), panel: hooks(calls) });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweep.pass();
    await waitFor(async () => (await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_requests WHERE state = 'done'`)).rows[0].n === 2);
    const reply = async (id: string) => JSON.parse((await rig.direct.query('SELECT reply FROM smdb_data.guild_requests WHERE id = $1', [id])).rows[0].reply ?? 'null');
    expect(await reply(wrong)).toMatchObject({ code: 'invalid', ran: false });
    expect(await reply(system)).toMatchObject({ code: 'not-allowed', ran: false });
    expect((await rig.direct.query('SELECT state FROM smdb_data.guild_requests WHERE id = $1', [late])).rows[0].state).toBe('pending');
    expect(calls).toEqual([]);
  });
});

describe('T10: the claim, the sender and the answers on real Postgres', () => {
  const down = { writerRoute: () => BOT_DOWN, isRunning: () => false } as any;
  const senderPools: Array<{ end(): Promise<void> }> = [];

  function sender(url: string, claim: string) {
    _resetGuildRequests();
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow({ holder_process: 'p-b', node_process_id: 'p-b', holder_node: 'n-b', holder_name: 'BRAVO', claim })] }),
      currentUrl: () => rig.url,
      requestDb: (u: string) => { const db = _pgRequestDbForTests(u === rig.url ? url : u); senderPools.push(db); return db; },
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
  }

  /** The route's answer while B's sweep passes every 100 ms. */
  async function routeWithSweep(sweep: GuildRequestSweep, op: any, payload: Record<string, unknown>, guildId = G1): Promise<PanelAnswer> {
    const plan = await planGuildRequest(down, guildId, op, 'owner');
    let answer: PanelAnswer | undefined;
    void runGuildRequest(plan, payload, async () => ({})).then(a => { answer = a; });
    const end = Date.now() + 20_000;
    while (!answer && Date.now() < end) {
      await sweep.pass();
      await new Promise(r => setTimeout(r, 100));
    }
    if (!answer) throw new Error('the route did not answer within 20 s');
    return answer;
  }

  afterAll(async () => {
    for (const p of senderPools) await p.end().catch(() => undefined);
    _setGuildRequestDeps(null);
    _resetGuildRequests();
  });

  it('T10: one claim takes data, action and read rows within their limits (1, 8, 64), returns their bodies and stores \'\'', async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    const bodies = new Map<string, string>();
    const add = async (op: string, body: Record<string, unknown>) => { const id = await insert(op, G1, 1, 'p-b', body); bodies.set(id, JSON.stringify(body)); return id; };
    await add('write', { module: 'm', filename: 'a.json', contentJson: '{}' });
    for (let i = 0; i < 9; i++) await add('panel:button', { panelId: 'p', buttonId: `b${i}`, actor: OWNER });
    for (let i = 0; i < 65; i++) await add('guild:channels', { actor: OWNER, n: i });
    const res = await rig.direct.query(REQUEST_CLAIM_SQL, ['p-b', randomUUID(), [2], [1], [Number(tokenB.claim)], DATA_OPS, 16, ACTION_OPS, 8, READ_OPS, 64]);
    const byOp = (op: string) => res.rows.filter((r: any) => r.op === op).length;
    expect([byOp('write'), byOp('panel:button'), byOp('guild:channels')]).toEqual([1, 8, 64]);
    for (const r of res.rows) {
      expect(r.body).toBe(bodies.get(r.id));
      expect(Number(r.shard_count)).toBe(2);
      expect(Number(r.shard_id)).toBe(1);
    }
    const stored = (await rig.direct.query(`SELECT id, state, body FROM smdb_data.guild_requests`)).rows;
    const taken = new Set(res.rows.map((r: any) => r.id));
    for (const r of stored) {
      if (taken.has(r.id)) expect([r.state, r.body]).toEqual(['applying', '']);
      else expect([r.state, r.body]).toEqual(['pending', bodies.get(r.id)]);
    }
    expect(stored.filter(r => !taken.has(r.id))).toHaveLength(2);
  });

  it('T10 (test 4): six membership fan-outs and a channels row are all claimed within 2 passes; 200 membership rows leave a button row to the first', async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    const claim = () => rig.direct.query(REQUEST_CLAIM_SQL, ['p-b', randomUUID(), [2], [1], [Number(tokenB.claim)], DATA_OPS, 16, ACTION_OPS, 8, READ_OPS, 64]);
    const ids = Array.from({ length: 100 }, (_, k) => String((BigInt(2 * k + 1)) << 22n));
    for (let i = 0; i < 6; i++) await insert('guild:membership', G1, 1, 'p-b', { ids, actor: { via: 'member', userId: '123456789012345678' } });
    await insert('guild:channels', G1, 1, 'p-b', { actor: OWNER });
    const first = await claim();
    const second = await claim();
    expect(first.rows.length + second.rows.length).toBe(7);
    await rig.direct.query('DELETE FROM smdb_data.guild_requests');
    for (let i = 0; i < 200; i++) await insert('guild:membership', G1, 1, 'p-b', { ids: [G1], actor: { via: 'member', userId: '123456789012345678' } });
    const button = await insert('panel:button', G1, 1, 'p-b', { panelId: 'p', buttonId: 'b', actor: OWNER });
    const pass = await claim();
    expect(pass.rows.map((r: any) => r.id)).toContain(button);
    expect(pass.rows.filter((r: any) => r.op === 'guild:membership')).toHaveLength(64);
  });

  it("T10: the sender inserts, polls the set and reads B's answer by its own statement; the stored reply is B's", async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    sender(rig.url, String(tokenB.claim));
    const calls: string[] = [];
    const sweep = new GuildRequestSweep({ db: sweepDb(poolOf()), processId: () => 'p-b', pairs: () => [{ shardCount: 2, shardId: 1, claim: Number(tokenB.claim) }], stoppedServing: () => false, isStopping: () => false, apply: async () => ({ ok: true }), panel: hooks(calls) });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const answer = await routeWithSweep(sweep, 'panel:button', { panelId: 'p', buttonId: 'b', actor: OWNER });
    expect(answer.reply).toMatchObject({ success: true, data: { v: 1 }, servedBy: 'BRAVO' });
    expect(calls).toEqual(['panel:button:p']);
    const rows = (await rig.direct.query(`SELECT state, body, reply, requested_by FROM smdb_data.guild_requests`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'done', body: '', requested_by: 'ALPHA' });
    expect(JSON.parse(rows[0].reply)).toEqual({ success: true, data: { v: 1 }, liveSince: 1, liveVersion: 0 });
  });

  it('T10: a 300 KiB panel answer is stored as oversize with success true, and the owner gets 200 with the note', async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    sender(rig.url, String(tokenB.claim));
    const big: PanelHooks = { ...hooks([]), answerPanel: async () => ({ success: true, data: { content: 'x'.repeat(300 * 1024) } }) };
    const sweep = new GuildRequestSweep({ db: sweepDb(poolOf()), processId: () => 'p-b', pairs: () => [{ shardCount: 2, shardId: 1, claim: Number(tokenB.claim) }], stoppedServing: () => false, isStopping: () => false, apply: async () => ({ ok: true }), panel: big });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const answer = await routeWithSweep(sweep, 'panel:button', { panelId: 'p', buttonId: 'b', actor: OWNER });
    const stored = (await rig.direct.query(`SELECT reply, octet_length(reply) AS n FROM smdb_data.guild_requests`)).rows[0];
    expect(Number(stored.n)).toBeLessThan(256 * 1024);
    expect(JSON.parse(stored.reply)).toMatchObject({ success: true, oversize: { reason: 'too-large' } });
    expect(answer).toMatchObject({ status: 200, reply: { success: true, data: null, servedBy: 'BRAVO' } });
    expect(String(answer.reply.note)).toMatch(/^On BRAVO: the panel action ran and its changes were saved; the panel it returned is \d+ KiB, too large to show here\./);
  });

  it('T10: a login refused (NOLOGIN) at the insert answers the maintenance text and inserts nothing', async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    await rig.direct.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nb15_blocked') THEN CREATE ROLE nb15_blocked NOLOGIN PASSWORD 'pw'; END IF; END $$`);
    await rig.direct.query(`ALTER ROLE nb15_blocked NOLOGIN`);
    const blocked = new URL(rig.url);
    blocked.username = 'nb15_blocked';
    blocked.password = 'pw';
    sender(blocked.toString(), String(tokenB.claim));
    const plan = await planGuildRequest(down, G1, 'panel:button', 'owner');
    const answer = await runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: OWNER }, async () => ({}));
    expect(answer).toMatchObject({ status: 503, reply: { code: 'maintenance', error: 'The database is in maintenance; nothing was run. Try again later.' } });
    expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.guild_requests`)).rows[0].n).toBe(0);
  });
});

describe('the holder map (ruling 14)', () => {
  it("lists every shard of meta's count with the claim row of that count only, while rows of another count exist", async () => {
    await takeShard(rig.direct, { processId: 'p-a', nodeId: 'n-a', shardId: 0, shardCount: 2 });
    await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    for (let shard = 0; shard < 4; shard++) await takeShard(rig.direct, { processId: 'p-c', nodeId: 'n-c', shardId: shard, shardCount: 4 });
    const two = (await rig.direct.query(HOLDER_MAP_SQL)).rows;
    expect(two.map(r => [Number(r.n), Number(r.shard), r.holder_process, r.holder_node])).toEqual([[2, 0, 'p-a', 'n-a'], [2, 1, 'p-b', 'n-b']]);
    expect(two.map(r => holderStateOf([r]))).toEqual([
      expect.objectContaining({ kind: 'row', shardCount: 2, shardId: 0, state: 'held', holderProcess: 'p-a' }),
      expect.objectContaining({ kind: 'row', shardCount: 2, shardId: 1, state: 'held', holderProcess: 'p-b' }),
    ]);
    await rig.direct.query(`UPDATE smdb_data.meta SET value = '{"count":4}' WHERE key = 'shard_count'`);
    const four = (await rig.direct.query(HOLDER_MAP_SQL)).rows;
    expect(four.map(r => [Number(r.n), Number(r.shard), r.holder_process])).toEqual([[4, 0, 'p-c'], [4, 1, 'p-c'], [4, 2, 'p-c'], [4, 3, 'p-c']]);
    await rig.direct.query(`UPDATE smdb_data.meta SET value = '{"count":3}' WHERE key = 'shard_count'`);
    const three = (await rig.direct.query(HOLDER_MAP_SQL)).rows;
    expect(three.map(r => [Number(r.n), Number(r.shard), r.holder_process])).toEqual([[3, 0, null], [3, 1, null], [3, 2, null]]);
    expect(three.map(r => holderStateOf([r]))).toEqual([0, 1, 2].map(shardId => expect.objectContaining({ kind: 'row', shardCount: 3, shardId, state: 'none' })));
    await rig.direct.query(`DELETE FROM smdb_data.meta WHERE key = 'shard_count'`);
    expect((await rig.direct.query(HOLDER_MAP_SQL)).rows).toEqual([]);
  });
});

describe('the cleanup (decision 16)', () => {
  it("empties the body of a pending row past claim_by + 5 s and of an expired row; deletes a done row 3 minutes old and keeps one 1 minute old", async () => {
    const pending = await insert('panel:execute', G1, 1, 'p-b', { panelId: 'p', actor: OWNER }, -10);
    const expired = await insert('panel:execute', G1, 1, 'p-b', { panelId: 'p', actor: OWNER }, -10);
    await rig.direct.query(`UPDATE smdb_data.guild_requests SET state = 'expired', done_at = now() WHERE id = $1`, [expired]);
    const inWindow = await insert('panel:execute', G1, 1, 'p-b', { panelId: 'p', actor: OWNER }, -2);
    const ahead = await insert('panel:execute', G1, 1, 'p-b', { panelId: 'p', actor: OWNER }, 5);
    const old = await insert('guild:roles', G1, 1, 'p-b', {});
    const recent = await insert('guild:roles', G1, 1, 'p-b', {});
    await rig.direct.query(`UPDATE smdb_data.guild_requests SET state = 'done', reply = '{}', done_at = now() - interval '3 minutes' WHERE id = $1`, [old]);
    await rig.direct.query(`UPDATE smdb_data.guild_requests SET state = 'done', reply = '{}', done_at = now() - interval '1 minute' WHERE id = $1`, [recent]);
    await rig.direct.query(CLEANUP_BODIES_SQL);
    await rig.direct.query(CLEANUP_SQL);
    const rows = new Map((await rig.direct.query('SELECT id, body FROM smdb_data.guild_requests')).rows.map(r => [r.id, r.body]));
    expect(rows.get(pending)).toBe('');
    expect(rows.get(expired)).toBe('');
    expect(rows.get(inWindow), 'a pending row 2 s past claim_by keeps its body until claim_by + 5 s').toBe(JSON.stringify({ panelId: 'p', actor: OWNER }));
    expect(rows.get(ahead)).toBe(JSON.stringify({ panelId: 'p', actor: OWNER }));
    expect(rows.has(old)).toBe(false);
    expect(rows.has(recent)).toBe(true);
  });
});

describe('the panel signal (decision 15) and the transport class (decision 21)', () => {
  it("a client that LISTENs receives the notifier's payload", async () => {
    const listener = new Client({ connectionString: rig.url });
    await listener.connect();
    try {
      const got: string[] = [];
      listener.on('notification', msg => { if (msg.channel === PANEL_CHANNEL) got.push(msg.payload ?? ''); });
      await listener.query(`LISTEN ${PANEL_CHANNEL}`);
      await rig.direct.query(NOTIFY_SQL, [[JSON.stringify({ g: G1, p: 'p' })]]);
      await waitFor(async () => got.length === 1);
      expect(JSON.parse(got[0])).toEqual({ g: G1, p: 'p' });
    } finally {
      await listener.end();
    }
  });

  it("T10: the notifier's payload for a watched pair arrives, and none for an unwatched one", async () => {
    _resetPanelLive();
    const pool = poolOf();
    _setNotifyDb({ notify: async payloads => { await pool.query({ text: NOTIFY_SQL, values: [payloads] }); } }, () => false);
    const listener = new Client({ connectionString: rig.url });
    await listener.connect();
    try {
      const got: string[] = [];
      listener.on('notification', msg => { if (msg.channel === PANEL_CHANNEL) got.push(msg.payload ?? ''); });
      await listener.query(`LISTEN ${PANEL_CHANNEL}`);
      registerInterest(G1, 'watched');
      noteLiveChange(G1, 'watched', { v: 1 });
      noteLiveChange(G1, 'unwatched', { v: 1 });
      await notifyTick();
      await waitFor(async () => got.length >= 1);
      await new Promise(r => setTimeout(r, 300));
      expect(got.map(p => JSON.parse(p))).toEqual([{ g: G1, p: 'watched' }]);
    } finally {
      await listener.end();
      _resetPanelLive();
    }
  });

  it("the test container's connections class 'local' or 'verified'", async () => {
    const config = pgConfig(rig.url);
    const client = new Client(config);
    await client.connect();
    try {
      expect(['local', 'verified']).toContain(transportOf(config, client));
    } finally {
      await client.end();
    }
  });
});
