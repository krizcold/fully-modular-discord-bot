import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 test 4 with the real start hooks (realPanelHooks: answerPanelMessage(..., 'request'), membershipOf,
// registerInterest), a readiness rig for the lease and a fake client: membership answers by the lease and the cache
// with incomplete; 'panel:list' over a row hides system and dev-only panels; a row's action runs inside the request
// scope that strips the 'web-ui-owner' pass; a lost lease answers not-held and runs nothing; the rate bucket is shared
// with the IPC listener; 'panel:live' registers the pair's interest and refuses a system panel.
const pm = vi.hoisted(() => ({ manager: null as any }));
vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => pm.manager };
});

import { Status } from 'discord.js';
import { GuildRequestSweep, type SweepDb } from '../../src/bot/internalSetup/fleet/guildRequests';
import { ANSWER_SQL, READ_ANSWERS_SQL, REQUEST_CLAIM_SQL } from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { _resetPanelHandler, answerPanelMessage, noteGuildWebUi } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { _interestCount, _resetPanelLive } from '../../src/bot/internalSetup/fleet/panelLive';
import { isFromRequest } from '../../src/bot/internalSetup/utils/panel/panelPermissions';
import { PanelWebUIAdapter } from '../../src/bot/internalSetup/utils/panel/panelWebUIAdapter';
import { setBackendKind } from '../helpers/backendKind';
import { readinessRig, stopDrivers } from '../helpers/readinessRig';
import { flush } from '../helpers/nb7World';
import { tokenFor } from '../helpers/fakeStore';

const MEMBER = '123456789012345678';
const OWNER = { via: 'owner', userId: 'web-ui-owner' };
/** A guild id on shard s of n. */
const onShard = (s: number, n: number, k: number) => String((BigInt(k * n + s)) << 22n);

function client(guilds: Array<Record<string, any>>, shards: Array<[number, any]>) {
  return {
    isReady: () => true,
    guilds: { cache: new Map(guilds.map(g => [g.id, { available: true, ...g }])) },
    channels: { cache: new Map(), fetch: vi.fn(async () => null) },
    users: { cache: new Map() },
    user: { id: '11' },
    application: { id: '11' },
    ws: { shards: new Map(shards) },
  };
}

function manager(c: any, panels: Record<string, any> = { p: { id: 'p', panelScope: 'guild' } }) {
  const scopes: boolean[] = [];
  return {
    scopes,
    getClient: () => c,
    getPanel: (id: string) => panels[id],
    getWebUIPanelList: () => Object.values(panels).map((p: any) => ({ id: p.id, scope: p.panelScope ?? 'guild', devOnly: p.devOnly })),
    executePanelForWebUI: vi.fn(async () => { scopes.push(isFromRequest()); return { success: true, data: { content: 'View' } }; }),
    handleWebUIButton: vi.fn(async () => { scopes.push(isFromRequest()); return { success: true, data: { content: 'View' } }; }),
  };
}

/** A sweep with the real hooks whose claim returns rows once; records every answer it writes. */
function sweepOf(rows: any[], pair: { shardCount: number; shardId: number }) {
  const answers = new Map<string, any>();
  let given = false;
  const db: SweepDb = {
    query: async (sql, values) => {
      if (sql === REQUEST_CLAIM_SQL) {
        if (given) return { rows: [], rowCount: 0 };
        given = true;
        return { rows, rowCount: rows.length };
      }
      if (sql === ANSWER_SQL) { answers.set(values[0] as string, JSON.parse(values[2] as string)); return { rows: [], rowCount: 1 }; }
      if (sql === READ_ANSWERS_SQL) {
        (values[0] as string[]).forEach((id, i) => answers.set(id, JSON.parse((values[1] as string[])[i])));
        return { rows: [], rowCount: (values[0] as string[]).length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const sweep = new GuildRequestSweep({
    db, processId: () => 'process-a', pairs: () => [{ ...pair, claim: 1 }], stoppedServing: () => false, isStopping: () => false,
    apply: async () => ({ ok: true }),
  });
  return { sweep, answers };
}

const row = (id: string, op: string, guildId: string, n: number, body: Record<string, unknown>) => ({
  id, guild_id: guildId, shard_count: n, shard_id: Number((BigInt(guildId) >> 22n) % BigInt(n)), op, body: JSON.stringify({ ...body, guildId }), requested_by: 'ALPHA', left_ms: 30_000,
});

let guildSeq = 0;
/** A snowflake-shaped guild id the start checks accept; with one shard every guild is on shard 0. */
const nextGuild = () => String(5_000_000 + ++guildSeq);
async function readyGuild(r: ReturnType<typeof readinessRig>): Promise<string> {
  const g = nextGuild();
  expect(await r.ws.hydrate(g, tokenFor())).toBe('ready');
  return g;
}

async function passAndSettle(sweep: GuildRequestSweep) {
  await sweep.pass();
  for (let i = 0; i < 20; i++) await flush();
}

beforeEach(() => {
  setBackendKind('postgres');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  _resetPanelHandler();
  _resetPanelLive();
  stopDrivers();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe("'guild:membership' through membershipOf (real hooks)", () => {
  it('answers every asked id whose shard is in the lease and that the cache holds available, with incomplete while a leased shard is not ready', async () => {
    const n = 4;
    readinessRig({ nodeId: 'node-a', processId: 'process-a', claims: { 0: 1, 1: 1 }, shardCount: n, shardIds: [0, 1] });
    const s0 = onShard(0, n, 1);
    const s1 = onShard(1, n, 1);
    const s0gone = onShard(0, n, 2);
    const s0down = onShard(0, n, 3);
    const s2 = onShard(2, n, 1);
    const shards: Array<[number, any]> = [[0, { status: Status.Ready }], [1, { status: Status.Connecting }]];
    pm.manager = manager(client([{ id: s0, name: 'A', shardId: 0 }, { id: s1, name: 'B', shardId: 1 }, { id: s2, name: 'C', shardId: 2 }, { id: s0down, name: 'D', shardId: 0, available: false }], shards));
    noteGuildWebUi(true);
    const { sweep, answers } = sweepOf([row('m1', 'guild:membership', s0, n, { ids: [s0, s1, s0gone, s0down, s2], actor: { via: 'member', userId: MEMBER } })], { shardCount: n, shardId: 0 });
    await passAndSettle(sweep);
    const answer = answers.get('m1');
    expect(answer.success).toBe(true);
    expect(answer.guilds.map((g: any) => g.id).sort()).toEqual([s0, s1].sort());
    expect(answer.incomplete).toBe(true);
    expect(sweep.startedCount()).toBe(0);
  });

  it('no incomplete once every leased shard is ready; a membership row of another shard count answers no guild', async () => {
    readinessRig({ nodeId: 'node-a', processId: 'process-a', claims: { 0: 1 }, shardCount: 2, shardIds: [0] });
    const g = onShard(0, 2, 1);
    pm.manager = manager(client([{ id: g, name: 'A', shardId: 0 }], [[0, { status: Status.Ready }]]));
    noteGuildWebUi(true);
    const { sweep, answers } = sweepOf([row('m2', 'guild:membership', g, 2, { ids: [g], actor: { via: 'member', userId: MEMBER } })], { shardCount: 2, shardId: 0 });
    await passAndSettle(sweep);
    expect(answers.get('m2')).toEqual({ success: true, guilds: [expect.objectContaining({ id: g, name: 'A' })] });
  });
});

describe('the start through answerPanelMessage(..., "request")', () => {
  it("'panel:list' over a row lists no system or dev-only panel", async () => {
    const r = readinessRig();
    const g = await readyGuild(r);
    pm.manager = manager(client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]), {
      p: { id: 'p', panelScope: 'guild' }, s: { id: 's', panelScope: 'system' }, d: { id: 'd', panelScope: 'guild', devOnly: true },
    });
    const { sweep, answers } = sweepOf([row('l1', 'panel:list', g, 1, { actor: OWNER })], { shardCount: 1, shardId: 0 });
    await passAndSettle(sweep);
    expect(answers.get('l1')).toMatchObject({ success: true });
    expect(answers.get('l1').panels.map((p: any) => p.id)).toEqual(['p']);
    expect((await answerPanelMessage('panel:list', { guildId: g }, 'ipc')).panels.map((p: any) => p.id)).toEqual(['p', 's', 'd']);
  });

  it("a row's action runs inside the request scope; this machine's IPC action does not", async () => {
    const r = readinessRig();
    const g = await readyGuild(r);
    pm.manager = manager(client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]));
    const { sweep, answers } = sweepOf([row('a1', 'panel:button', g, 1, { panelId: 'p', buttonId: 'b', actor: OWNER })], { shardCount: 1, shardId: 0 });
    await passAndSettle(sweep);
    expect(answers.get('a1')).toMatchObject({ success: true });
    await answerPanelMessage('panel:button', { panelId: 'p', buttonId: 'b', userId: 'web-ui-owner', guildId: g }, 'ipc');
    expect(pm.manager.scopes).toEqual([true, false]);
  });

  it("allowedUsers through rows and the real adapter: a row's 'web-ui-owner' is refused with the local text and runs nothing, a listed user id runs; locally the owner passes", async () => {
    const r = readinessRig();
    const g = await readyGuild(r);
    const c = client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]);
    const callback = vi.fn(async () => ({ content: 'View' }));
    const panel = { id: 'p', name: 'p', panelScope: 'guild', allowedUsers: [MEMBER], callback };
    const adapter = new PanelWebUIAdapter(c as any, new Map([['p', panel]]) as never, {} as never);
    pm.manager = {
      getClient: () => c,
      getPanel: (id: string) => (id === 'p' ? panel : undefined),
      getWebUIPanelList: () => [{ id: 'p', scope: 'guild' }],
      executePanelForWebUI: (panelId: string, userId: string, guildId?: string | null, nav?: string[], channelId?: string | null) => adapter.executePanelForWebUI(panelId, userId, guildId, nav, channelId),
    };
    const owner = sweepOf([row('u1', 'panel:execute', g, 1, { panelId: 'p', actor: OWNER })], { shardCount: 1, shardId: 0 });
    await passAndSettle(owner.sweep);
    expect(owner.answers.get('u1')).toMatchObject({ success: false, error: 'You do not have permission to access this panel' });
    expect(callback).not.toHaveBeenCalled();
    const listed = sweepOf([row('u2', 'panel:execute', g, 1, { panelId: 'p', actor: { via: 'owner', userId: MEMBER } })], { shardCount: 1, shardId: 0 });
    await passAndSettle(listed.sweep);
    expect(listed.answers.get('u2')).toMatchObject({ success: true });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(await answerPanelMessage('panel:execute', { panelId: 'p', userId: 'web-ui-owner', guildId: g }, 'ipc')).toMatchObject({ success: true });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('a lease that lost the shard answers not-held and runs nothing', async () => {
    const r = readinessRig({ nodeId: 'node-a', processId: 'process-a', claims: {}, shardCount: 1, shardIds: [] });
    const g = nextGuild();
    pm.manager = manager(client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]));
    const { sweep, answers } = sweepOf([row('a2', 'panel:button', g, 1, { panelId: 'p', buttonId: 'b', actor: OWNER })], { shardCount: 1, shardId: 0 });
    await passAndSettle(sweep);
    expect(answers.get('a2')).toMatchObject({ success: false, code: 'not-held' });
    expect(pm.manager.handleWebUIButton).not.toHaveBeenCalled();
  });

  it('the rate bucket is shared with the IPC listener: 5 through IPC, the 6th through a row is refused', async () => {
    const r = readinessRig();
    const g = await readyGuild(r);
    pm.manager = manager(client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]));
    for (let i = 0; i < 5; i++) {
      expect(await answerPanelMessage('panel:button', { panelId: 'p', buttonId: 'b', userId: MEMBER, guildId: g }, 'ipc')).toMatchObject({ success: true });
    }
    const { sweep, answers } = sweepOf([row('a3', 'panel:button', g, 1, { panelId: 'p', buttonId: 'b', actor: { via: 'owner', userId: MEMBER } })], { shardCount: 1, shardId: 0 });
    await passAndSettle(sweep);
    expect(answers.get('a3')).toMatchObject({ success: false });
    expect(String(answers.get('a3').error)).toContain('Rate limit');
    expect(pm.manager.handleWebUIButton).toHaveBeenCalledTimes(5);
  });

  it("'panel:live' registers the pair's interest; a system panel answers not-allowed and registers none", async () => {
    const r = readinessRig();
    const g = await readyGuild(r);
    pm.manager = manager(client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]), { p: { id: 'p', panelScope: 'guild' }, sys: { id: 'sys', panelScope: 'system' } });
    const { sweep, answers } = sweepOf([
      row('v1', 'panel:live', g, 1, { panelId: 'p', actor: OWNER }),
      row('v2', 'panel:live', g, 1, { panelId: 'sys', actor: OWNER }),
    ], { shardCount: 1, shardId: 0 });
    await passAndSettle(sweep);
    expect(answers.get('v1')).toMatchObject({ success: true, data: null, notifying: null });
    expect(typeof answers.get('v1').since).toBe('number');
    expect(answers.get('v2')).toMatchObject({ success: false, ran: false, code: 'not-allowed' });
    expect(_interestCount()).toBe(1);
  });

  it("an owner row's panel action registers the interest before it runs and carries liveSince; a member row's does not", async () => {
    const r = readinessRig();
    const g = await readyGuild(r);
    pm.manager = manager(client([{ id: g, shardId: 0 }], [[0, { status: Status.Ready }]]));
    noteGuildWebUi(true);
    let interestsAtRun = -1;
    pm.manager.handleWebUIButton = vi.fn(async () => { interestsAtRun = _interestCount(); return { success: true, data: { content: 'View' } }; });
    const { sweep, answers } = sweepOf([row('o1', 'panel:button', g, 1, { panelId: 'p', buttonId: 'b', actor: OWNER })], { shardCount: 1, shardId: 0 });
    await passAndSettle(sweep);
    expect(interestsAtRun).toBe(1);
    expect(typeof answers.get('o1').liveSince).toBe('number');
    expect(answers.get('o1').liveVersion, "R4 ruling (a): the action's view is kept under the pair's first version").toBe(1);
    _resetPanelLive();
    const member = sweepOf([row('o2', 'panel:button', g, 1, { panelId: 'p', buttonId: 'b', actor: { via: 'member', userId: MEMBER } })], { shardCount: 1, shardId: 0 });
    await passAndSettle(member.sweep);
    expect(member.answers.get('o2')).toMatchObject({ success: true });
    expect(member.answers.get('o2')).not.toHaveProperty('liveSince');
    expect(member.answers.get('o2')).not.toHaveProperty('liveVersion');
    expect(_interestCount()).toBe(0);
  });
});
