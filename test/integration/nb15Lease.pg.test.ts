import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 10's lease rows on real Postgres with the real start hooks (no `panel` dep: answerPanelMessage(...,
// 'request') and runPanelAction): a holder whose lease lost the shard between the claim and the start answers
// not-held and runs nothing; a panel action whose write lands after another process took the shard has its write
// refused under B's fence, answers ran with truth 'deposed', and the stored document keeps its old bytes.
const pm = vi.hoisted(() => ({ manager: null as any }));
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => pm.manager };
});

import { GuildRequestSweep, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import { REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { ranTruthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { _resetPanelHandler, NOT_HELD } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { _resetPanelLive } from '../../src/bot/internalSetup/fleet/panelLive';
import { _pgRequestDbForTests, _resetGuildRequests, _setGuildRequestDeps, planGuildRequest, runGuildRequest, type PanelAnswer } from '../../src/webui/utils/guildRequests';
import { BOT_DOWN, heldRow } from '../helpers/nb7Rig';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { takeShard } from '../helpers/pgClaims';

const OWNER = { via: 'owner', userId: 'web-ui-owner' };
/** Guilds of shard 1 of 2. */
const GUILD_LEASE = String(1n << 22n);
const GUILD_FENCE = String(3n << 22n);

let rig: ClaimRig;
const pools: Pool[] = [];
let driver: DataReadinessDriver | null = null;

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  driver?.stop();
  driver = null;
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  _resetPanelHandler();
  _resetPanelLive();
  vi.restoreAllMocks();
});

function manager(handleWebUIButton: (...args: any[]) => Promise<any>) {
  return {
    getClient: () => ({ guilds: { cache: new Map() }, channels: { cache: new Map() } }),
    getPanel: (id: string) => (id === 'p' ? { id: 'p', panelScope: 'guild' } : undefined),
    getWebUIPanelList: () => [{ id: 'p', scope: 'guild' }],
    handleWebUIButton: vi.fn(handleWebUIButton),
  };
}

/** B's readiness and working set over the rig's real backend, leasing shard 1 under B's claim. */
async function holderB(token: FenceToken, guildId: string) {
  const ws = initWorkingSet(rig.backend);
  driver = initDataReadiness(rig.backend, ws, { held: false });
  driver.onLeaseChanged({ nodeId: 'n-b', processId: 'p-b', claims: { 1: token.claim }, shardCount: 2, shardIds: [1] });
  expect(await ws.hydrate(guildId, token)).toBe('ready');
  return ws;
}

async function insertButton(guildId: string): Promise<string> {
  const id = randomUUID();
  await rig.direct.query(
    `INSERT INTO smdb_data.guild_requests (id, guild_id, shard_count, shard_id, for_process, op, body, requested_by, claim_by, answer_by)
     VALUES ($1, $2, 2, 1, 'p-b', 'panel:button', $3, 'ALPHA', now() + interval '5 seconds', now() + interval '30 seconds')`,
    [id, guildId, JSON.stringify({ panelId: 'p', buttonId: 'b', actor: OWNER })]);
  return id;
}

function sweepOf(token: FenceToken, afterClaim: () => void = () => undefined) {
  const pool = new Pool({ connectionString: rig.url, max: 4 });
  pool.on('error', () => undefined);
  pools.push(pool);
  const db: SweepDb = {
    query: async (text, values, boundMs) => {
      const res = await pool.query({ text, values, query_timeout: boundMs } as any);
      if (text === REQUEST_CLAIM_SQL && (res.rowCount ?? 0) > 0) afterClaim();
      return res;
    },
  };
  return new GuildRequestSweep({
    db, processId: () => 'p-b', pairs: () => [{ shardCount: 2, shardId: 1, claim: Number(token.claim) }],
    stoppedServing: () => false, isStopping: () => false, apply: async () => ({ ok: true }),
  });
}

async function storedReply(id: string, ms = 20_000): Promise<any> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const row = (await rig.direct.query('SELECT state, reply FROM smdb_data.guild_requests WHERE id = $1', [id])).rows[0];
    if (row?.state === 'done') return JSON.parse(row.reply);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('the row was not answered within 20 s');
}

async function storedDoc(guildId: string): Promise<string | null> {
  const res = await rig.direct.query('SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3', [guildId, 'm', 'x.json']);
  return res.rows[0]?.doc ?? null;
}

describe('T10: the lease rows through the real start hooks', () => {
  it('a lease that lost shard 1 between the claim and the start answers not-held and never calls the panel', async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    await holderB(tokenB, GUILD_LEASE);
    pm.manager = manager(async () => ({ success: true, data: { content: 'View' } }));
    const id = await insertButton(GUILD_LEASE);
    const sweep = sweepOf(tokenB, () => {
      driver!.onLeaseChanged({ nodeId: 'n-b', processId: 'p-b', claims: {}, shardCount: 2, shardIds: [] });
    });
    await sweep.pass();
    expect(await storedReply(id)).toEqual({ ...NOT_HELD, liveSince: expect.any(Number), liveVersion: 0 });
    expect(pm.manager.handleWebUIButton).not.toHaveBeenCalled();
  });

  it("through the sender: a lease that lost shard 1 after the claim gives the route 503 not-taken with 'nothing was run', the panel is never called, and the row holds not-held", async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    await holderB(tokenB, GUILD_LEASE);
    pm.manager = manager(async () => ({ success: true, data: { content: 'View' } }));
    _resetGuildRequests();
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow({ holder_process: 'p-b', node_process_id: 'p-b', holder_node: 'n-b', holder_name: 'BRAVO', claim: String(tokenB.claim) })] }),
      currentUrl: () => rig.url,
      requestDb: (u: string) => { const db = _pgRequestDbForTests(u); pools.push(db as unknown as Pool); return db; },
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    const sweep = sweepOf(tokenB, () => {
      driver!.onLeaseChanged({ nodeId: 'n-b', processId: 'p-b', claims: {}, shardCount: 2, shardIds: [] });
    });
    const plan = await planGuildRequest({ writerRoute: () => BOT_DOWN, isRunning: () => false } as any, GUILD_LEASE, 'panel:button', 'owner');
    let answer: PanelAnswer | undefined;
    void runGuildRequest(plan, { panelId: 'p', buttonId: 'b', actor: OWNER }, async () => ({})).then(a => { answer = a; });
    const end = Date.now() + 20_000;
    while (!answer && Date.now() < end) {
      await sweep.pass();
      await new Promise(r => setTimeout(r, 100));
    }
    expect(answer).toMatchObject({ status: 503, reply: { success: false, code: 'not-taken', error: 'On BRAVO: the bot stopped serving this server before it ran the panel action; nothing was run. Try again in a moment.' } });
    expect(pm.manager.handleWebUIButton).not.toHaveBeenCalled();
    const rows = (await rig.direct.query('SELECT state, body, reply, for_process FROM smdb_data.guild_requests')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'done', body: '', for_process: 'p-b' });
    expect(JSON.parse(rows[0].reply)).toEqual({ ...NOT_HELD, liveSince: expect.any(Number), liveVersion: 0 });
  }, 30_000);

  it("a write under B's claim that lands after another process took shard 1 is refused deposed; the answer says it ran, and the stored document keeps its bytes", async () => {
    const tokenB = await takeShard(rig.direct, { processId: 'p-b', nodeId: 'n-b', shardId: 1, shardCount: 2 });
    await holderB(tokenB, GUILD_FENCE);
    const options = { guildId: GUILD_FENCE, category: 'm' };
    let takeOver = false;
    pm.manager = manager(async () => {
      if (takeOver) await takeShard(rig.direct, { processId: 'p-c', nodeId: 'n-c', shardId: 1, shardCount: 2 });
      saveData('x.json', options, { v: takeOver ? 2 : 1 });
      return { success: true, data: { content: 'View' } };
    });
    const sweep = sweepOf(tokenB);

    const first = await insertButton(GUILD_FENCE);
    await sweep.pass();
    expect(await storedReply(first)).toMatchObject({ success: true, data: { content: 'View' } });
    const before = await storedDoc(GUILD_FENCE);
    expect(JSON.parse(before!)).toEqual({ v: 1 });

    takeOver = true;
    const second = await insertButton(GUILD_FENCE);
    await sweep.pass();
    const reply = await storedReply(second);
    expect(reply).toMatchObject({ success: false, ran: true, truth: 'deposed', partial: false, error: ranTruthText({ answer: 'deposed', partial: false }) });
    expect(reply).not.toHaveProperty('pending');
    expect(pm.manager.handleWebUIButton).toHaveBeenCalledTimes(2);
    expect(await storedDoc(GUILD_FENCE)).toBe(before);
    expect(Number((await rig.row(1, 2)).claim_text)).toBeGreaterThan(Number(tokenB.claim));
  });
});
