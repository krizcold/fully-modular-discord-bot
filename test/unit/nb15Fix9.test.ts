import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB15 code review round 9, the fixes: the claim keeps a connection of its own beside large read answers (W1); the
// cleanup runs on its own tick (M1); a read's refusal is answered at once (M2); the notify probe stops with no
// interest (M3); answered reads write no log line (M4); one command lookup per invoke (M5); the member notice names its
// cause (M6); a maintenance or stopped-serving refusal of an invoke carries ran false and answers 400 (M8); the note on
// left-out captured replies (TX1); an 'unprotected' request client sends no statement at its connect (T-11).
const local = vi.hoisted(() => ({ commands: [] as any[], scans: 0 }));
const bot = vi.hoisted(() => ({ client: null as any }));
const pgFake = vi.hoisted(() => ({ sent: [] as string[], remote: '203.0.113.5' }));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => { local.scans += 1; return local.commands; } }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/bot/internalSetup/utils/panelManager')>();
  return { ...real, getPanelManager: () => ({ getClient: () => bot.client }) };
});
vi.mock('pg', async orig => {
  const real = await orig<any>();
  class Pool {
    totalCount = 0;
    idleCount = 0;
    private listeners: Array<(client: any) => void> = [];
    constructor(public options: any) {}
    on(event: string, fn: (client: any) => void) {
      if (event === 'connect') this.listeners.push(fn);
      return this;
    }
    async connect() {
      const client: any = {
        connection: { stream: { remoteAddress: pgFake.remote } },
        on: () => undefined,
        query: async (config: any) => { pgFake.sent.push(config.text); return { rows: [{ server: 'S1' }], rowCount: 1 }; },
        release: () => undefined,
      };
      for (const fn of this.listeners) fn(client);
      return client;
    }
    async end() { /* nothing to end */ }
  }
  return { ...real, Pool, default: { ...(real.default ?? real), Pool } };
});

import {
  GuildRequestSweep,
  gatedSweepDb,
  reservedSweepDb,
  type PanelHooks,
  type SweepDb,
  type SweepDeps,
  type SweepGate,
  type SweepPool,
} from '../../src/bot/internalSetup/fleet/guildRequests';
import {
  ANSWER_SQL,
  CLEANUP_BODIES_SQL,
  CLEANUP_SQL,
  READ_ANSWERS_SQL,
  REQUEST_CLAIM_SQL,
  REQUEST_INSERT_SQL,
} from '../../src/bot/internalSetup/utils/dataBackends/guildRequestSql';
import { _resetPanelLive, _setNotifyDb, isNotifying, liveAnswer, noteLiveChange, notifyTick, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';
import { answerInvokeMessage } from '../../src/bot/internalSetup/utils/ipcCommandHandler';
import { _resetPanelHandler } from '../../src/bot/internalSetup/utils/ipcPanelHandler';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { STOPPED_SERVING_TEXT, setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { MEMBER_NOTICES, _resetMemberLists, memberNoticeOf, memberServerList, type MemberListDeps } from '../../src/webui/utils/memberGuilds';
import { PANEL_TEXTS, SERVER_IDENTITY_SQL, _pgRequestDbForTests, planGuildRequest, runGuildRequest, type Outcome } from '../../src/webui/utils/guildRequests';
import { createCommandRoutes } from '../../src/webui/routes/commands';
import { BOT_DOWN, GUILD, fakeTime, nb7Rig, resetNb7, type Rig } from '../helpers/nb7Rig';

const OWNER = { via: 'owner', userId: 'web-ui-owner' };
const GATE: SweepGate = { epoch: () => 1, refusal: () => null, stopWhy: () => null };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };

let ids = 0;
function row(over: Record<string, unknown> = {}) {
  return {
    id: `r${++ids}`, guild_id: GUILD, shard_count: 2, shard_id: 1, op: 'panel:list',
    body: JSON.stringify({ actor: OWNER }), requested_by: 'ALPHA', left_ms: 5000, ...over,
  };
}

function hooks(over: Partial<PanelHooks> = {}): PanelHooks {
  return {
    answerPanel: async () => ({ success: true, panels: [] }),
    answerInvoke: async () => ({ success: true, ran: true, captured: [] }),
    maintenanceRefusal: () => null,
    getPanel: () => ({ panelScope: 'guild' }),
    getCommand: () => ({ devOnly: false }),
    guildWebUi: () => true,
    membership: () => ({ success: true, guilds: [] }),
    registerInterest: () => 1234,
    ...over,
  };
}

function deps(db: SweepDb, over: Partial<SweepDeps> = {}): SweepDeps {
  let batch = 0;
  return {
    db,
    processId: () => 'p-a',
    pairs: () => [{ shardCount: 2, shardId: 1, claim: 9 }],
    stoppedServing: () => false,
    isStopping: () => false,
    apply: async () => ({ ok: true }),
    newId: () => `b${++batch}`,
    serving: () => true,
    gate: GATE,
    panel: hooks(),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  ids = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A pool of `max` connections handed out first come, first served; a read-answer write holds one 2 s and fails. */
function modelPool(max: number, readsPerClaim: number, claimsWithReads: number) {
  const state = { open: 0, queue: [] as Array<() => void>, claimWaits: [] as number[], claimAt: [] as number[] };
  const pool: SweepPool = {
    async connect() {
      const asked = performance.now();
      if (state.open >= max) await new Promise<void>(resolve => state.queue.push(resolve));
      else state.open += 1;
      const waited = performance.now() - asked;
      let done = false;
      return {
        query: async (config: any) => {
          if (config.text === REQUEST_CLAIM_SQL) {
            state.claimWaits.push(waited);
            state.claimAt.push(performance.now());
            const rows = state.claimAt.length <= claimsWithReads ? Array.from({ length: readsPerClaim }, () => row()) : [];
            return { rows, rowCount: rows.length };
          }
          if (config.text === READ_ANSWERS_SQL) {
            await sleep(2000);
            throw new Error('Query read timeout');
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {
          if (done) return;
          done = true;
          const next = state.queue.shift();
          if (next) next();
          else state.open -= 1;
        },
      };
    },
  };
  return { pool, state };
}

/** The longest time between two claims, and from the last claim to now, over the run. */
function longestGap(at: number[]): number {
  let gap = 0;
  for (let i = 1; i < at.length; i++) gap = Math.max(gap, at[i] - at[i - 1]);
  return Math.max(gap, performance.now() - (at[at.length - 1] ?? 0));
}

describe('W1: large read answers never hold up the next claim', () => {
  const big = { answerPanel: async () => ({ success: true, panels: 'x'.repeat(200 * 1024) }) };

  it('five passes of 16 reads of 200 KiB each, whose writes hang 2 s and fail: every claim gets a connection at once and runs each second', async () => {
    const { pool, state } = modelPool(3, 16, 5);
    const sweep = new GuildRequestSweep(deps(reservedSweepDb(gatedSweepDb(pool, GATE), 2), { panel: hooks(big) }));
    sweep.start();
    await vi.advanceTimersByTimeAsync(30_000);
    sweep.stop();
    expect(state.claimAt.length).toBeGreaterThanOrEqual(29);
    expect(Math.max(...state.claimWaits)).toBe(0);
    expect(longestGap(state.claimAt), 'a row inserted after a claim is taken by the next claim, inside its 5 s pickup').toBeLessThanOrEqual(1100);
  });

  it('a pass writes its read-answer groups one at a time', async () => {
    let writing = 0;
    let most = 0;
    let first = true;
    const db: SweepDb = {
      query: async (text, values) => {
        if (text === REQUEST_CLAIM_SQL) {
          if (!first) return { rows: [] };
          first = false;
          return { rows: Array.from({ length: 6 }, () => row()) };
        }
        if (text === READ_ANSWERS_SQL) {
          writing += 1;
          most = Math.max(most, writing);
          await sleep(100);
          writing -= 1;
          return { rows: [], rowCount: (values[0] as unknown[]).length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const sweep = new GuildRequestSweep(deps(db, { panel: hooks(big) }));
    await sweep.pass();
    await vi.advanceTimersByTimeAsync(2000);
    expect(most).toBe(1);
  });

  it('without the reservation the same load makes a claim wait for a connection (the test bites)', async () => {
    const { pool, state } = modelPool(3, 16, 5);
    const sweep = new GuildRequestSweep(deps(gatedSweepDb(pool, GATE), { panel: hooks(big) }));
    sweep.start();
    await vi.advanceTimersByTimeAsync(30_000);
    sweep.stop();
    expect(Math.max(...state.claimWaits, longestGap(state.claimAt))).toBeGreaterThan(1100);
  });

  it('the reservation hands a freed connection to the next waiting statement and lets the claim pass every queue', async () => {
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const inner: SweepDb = {
      query: async text => {
        order.push(`start ${text === REQUEST_CLAIM_SQL ? 'claim' : text}`);
        if (text !== REQUEST_CLAIM_SQL) await new Promise<void>(resolve => gates.push(resolve));
        return { rows: [] };
      },
    };
    const db = reservedSweepDb(inner, 2);
    const a = db.query('A', [], 1000);
    const b = db.query('B', [], 1000);
    const c = db.query('C', [], 1000);
    await flush();
    expect(order).toEqual(['start A', 'start B']);
    await db.query(REQUEST_CLAIM_SQL, [], 1000);
    expect(order).toEqual(['start A', 'start B', 'start claim']);
    gates.shift()!();
    await a;
    await flush();
    expect(order).toEqual(['start A', 'start B', 'start claim', 'start C']);
    gates.shift()!();
    gates.shift()!();
    await Promise.all([b, c]);
  });

  it('a third statement behind two held slots ends not sent at 5 s and never reaches the database', async () => {
    const started: string[] = [];
    const inner: SweepDb = {
      query: async text => {
        started.push(text);
        await new Promise<void>(() => undefined);
        return { rows: [] };
      },
    };
    const db = reservedSweepDb(inner, 2);
    void db.query('A', [], 1000);
    void db.query('B', [], 1000);
    const third = db.query(ANSWER_SQL, [], 2000).then(() => 'answered', (error: any) => ({ notSent: error?.notSent, at: performance.now() }));
    const from = performance.now();
    await vi.advanceTimersByTimeAsync(4999);
    expect(started).toEqual(['A', 'B']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toEqual({ notSent: true, at: from + 5000 });
    expect(started).toEqual(['A', 'B']);
  });
});

describe('M1: the cleanup runs on its own tick, never inside a pass', () => {
  it('a pass sends no cleanup; a cleanup that takes 5 s holds up no claim; two ticks at once send it once', async () => {
    const sent: Array<{ text: string; at: number }> = [];
    const db: SweepDb = {
      query: async text => {
        sent.push({ text, at: performance.now() });
        if (text === CLEANUP_BODIES_SQL || text === CLEANUP_SQL) await sleep(5000);
        return { rows: [], rowCount: 0 };
      },
    };
    const sweep = new GuildRequestSweep(deps(db));
    await sweep.pass();
    expect(sent.map(s => s.text)).toEqual([REQUEST_CLAIM_SQL]);
    sent.length = 0;
    sweep.start();
    await vi.advanceTimersByTimeAsync(9000);
    sweep.stop();
    const bodies = sent.filter(s => s.text === CLEANUP_BODIES_SQL);
    expect(bodies).toHaveLength(1);
    const claims = sent.filter(s => s.text === REQUEST_CLAIM_SQL).map(s => s.at);
    const during = claims.filter(at => at > bodies[0].at && at < bodies[0].at + 10_000);
    expect(during.length).toBeGreaterThanOrEqual(7);
    const again = new GuildRequestSweep(deps(db));
    sent.length = 0;
    const one = again.cleanupTick();
    const two = again.cleanupTick();
    expect(two).toBe(one);
    await vi.advanceTimersByTimeAsync(10_000);
    await one;
    expect(sent.filter(s => s.text === CLEANUP_BODIES_SQL)).toHaveLength(1);
  });
});

describe('M4: an answered read writes no log line', () => {
  it("a read's answer logs nothing on any console channel", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let first = true;
    let answeredRows = 0;
    const db: SweepDb = {
      query: async (text, values) => {
        if (text === REQUEST_CLAIM_SQL) {
          if (!first) return { rows: [] };
          first = false;
          return { rows: [row({ op: 'panel:live', body: JSON.stringify({ panelId: 'p', actor: OWNER }) })] };
        }
        if (text === READ_ANSWERS_SQL) {
          answeredRows += (values[0] as unknown[]).length;
          return { rows: [], rowCount: (values[0] as unknown[]).length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const sweep = new GuildRequestSweep(deps(db));
    await sweep.pass();
    await flush();
    expect(answeredRows).toBe(1);
    for (const spy of [console.log, console.debug, console.info, console.warn, console.error]) expect((spy as any).mock.calls).toEqual([]);
  });
});

function fakeClient() {
  return {
    isReady: () => true,
    guilds: { cache: new Map() },
    channels: { cache: new Map(), fetch: async () => null },
    users: { cache: new Map() },
    user: { id: '11' },
    application: { id: '11' },
  };
}

describe('M5: one command lookup per invoke', () => {
  afterEach(() => {
    _resetPanelHandler();
    bot.client = null;
    local.commands = [];
    local.scans = 0;
  });

  it("the start check's lookup is handed to the invoke", async () => {
    const lookups: unknown[] = [];
    let looked = 0;
    let first = true;
    const db: SweepDb = {
      query: async text => {
        if (text === REQUEST_CLAIM_SQL && first) {
          first = false;
          return { rows: [row({ op: 'command:invoke', body: JSON.stringify({ command: 'probe', actor: OWNER }) })] };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const panel = hooks({
      getCommand: name => { looked += 1; return name === 'probe' ? { devOnly: false } : undefined; },
      answerInvoke: async (_body, lookup) => { lookups.push(lookup); return { success: true, ran: true, captured: [] }; },
    });
    const sweep = new GuildRequestSweep(deps(db, { panel }));
    await sweep.pass();
    await flush();
    expect(looked).toBe(1);
    expect(lookups).toEqual([{ command: { devOnly: false } }]);
  });

  it('an invoke given a lookup scans the commands only in the dispatcher; a lookup that found nothing scans none', async () => {
    bot.client = fakeClient();
    local.commands = [{ name: 'probe', callback: async () => undefined }];
    const ran = await answerInvokeMessage({ command: 'probe', force: true }, 'request', { command: { name: 'probe' } });
    expect(ran).toMatchObject({ ran: true });
    expect(local.scans).toBe(1);
    local.scans = 0;
    expect(await answerInvokeMessage({ command: 'gone', force: true }, 'request', { command: undefined })).toEqual({ success: false, ran: false, error: 'no such command: gone' });
    expect(local.scans).toBe(0);
  });
});

describe('M8: a maintenance or stopped-serving refusal of an invoke carries ran false and answers 400', () => {
  afterEach(() => {
    setMaintenanceGate(null);
    setStoppedServingHook(null);
  });

  it('answerInvokeMessage adds ran: false to both refusals', async () => {
    setMaintenanceGate({ cause: 'hook', message: 'Back at noon.' });
    expect(await answerInvokeMessage({ command: 'probe' }, 'request')).toEqual({ success: false, maintenance: true, error: 'Back at noon.', ran: false });
    setMaintenanceGate(null);
    setStoppedServingHook(() => true);
    expect(await answerInvokeMessage({ command: 'probe' }, 'ipc')).toEqual({ success: false, error: STOPPED_SERVING_TEXT, ran: false });
  });

  it("the invoke route answers 400 with the refusal's text, also for a maintenance boot's answer without ran", async () => {
    const route = (reply: any) => {
      const b: any = { isRunning: () => true, writerRoute: () => ({ route: 'child' }), panelIpc: async () => reply, emitPanelUpdate: () => undefined, emitPanelLiveStatus: () => undefined };
      const router: any = createCommandRoutes(b);
      const layer = router.stack.find((l: any) => l.route?.path === '/invoke' && l.route.methods.post);
      const stack = layer.route.stack;
      const out = { status: 200, body: undefined as any };
      const res: any = { status: (code: number) => { out.status = code; return res; }, json: (body: any) => { out.body = body; return res; } };
      return stack[stack.length - 1].handle({ body: { command: 'probe' }, query: {}, session: {} }, res).then(() => out);
    };
    expect(await route({ success: false, maintenance: true, error: 'Back at noon.', ran: false })).toMatchObject({ status: 400, body: { error: 'Back at noon.' } });
    expect(await route({ success: false, maintenance: true, error: 'Back at noon.' })).toMatchObject({ status: 400, body: { error: 'Back at noon.' } });
    expect(await route({ success: false, error: STOPPED_SERVING_TEXT, ran: false })).toMatchObject({ status: 400, body: { error: STOPPED_SERVING_TEXT } });
    expect(await route({ success: false, ran: true, error: 'broke' })).toMatchObject({ status: 500 });
  });
});

describe('M3: the notify probe stops when no interest is left', () => {
  afterEach(() => _resetPanelLive());

  it('a failing notifier logs while a panel is watched, then sends nothing and logs nothing once no interest is left', async () => {
    _resetPanelLive();
    let calls = 0;
    _setNotifyDb({ notify: async () => { calls += 1; throw new Error('Query read timeout'); } }, () => true);
    registerInterest(GUILD, 'p');
    noteLiveChange(GUILD, 'p', { v: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    const lines = () => (console.error as any).mock.calls.filter((c: any[]) => String(c[0]).startsWith('[PanelLive] Could not tell')).length;
    expect(lines()).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    const before = calls;
    const logged = lines();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toBe(before);
    expect(lines()).toBe(logged);
    registerInterest(GUILD, 'p');
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBeGreaterThan(before);
  });

  it('after a stop the notify state is unknown until a notify works or fails; a recovery announces every watched pair', async () => {
    _resetPanelLive();
    let fail = true;
    const sent: string[][] = [];
    _setNotifyDb({ notify: async payloads => { sent.push(payloads); if (fail) throw new Error('Query read timeout'); } }, () => true);
    registerInterest(GUILD, 'p');
    noteLiveChange(GUILD, 'p', { v: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(liveAnswer(GUILD, 'p', registerInterest(GUILD, 'p')).notifying).toBe(false);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(isNotifying(), 'the notifier stopped for lack of interest').toBeNull();
    fail = false;
    sent.length = 0;
    const since = registerInterest(GUILD, 'p');
    expect(liveAnswer(GUILD, 'p', since).notifying).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([[]]);
    expect(isNotifying()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent, 'the watched pair is announced, so its web panel fetches and learns notifying').toEqual([[], [JSON.stringify({ g: GUILD, p: 'p' })]]);
    expect(liveAnswer(GUILD, 'p', since).notifying).toBe(true);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(isNotifying()).toBeNull();
    fail = true;
    registerInterest(GUILD, 'q');
    await vi.advanceTimersByTimeAsync(1000);
    expect(isNotifying(), 'a probe that fails again reports false').toBe(false);
  });

  it('a failure with no interest left logs nothing', async () => {
    _resetPanelLive();
    _setNotifyDb({ notify: async () => { throw new Error('down'); } }, () => true);
    registerInterest(GUILD, 'p');
    noteLiveChange(GUILD, 'p', { v: 1 });
    await vi.advanceTimersByTimeAsync(91_000);
    (console.error as any).mockClear();
    await notifyTick();
    expect((console.error as any).mock.calls).toEqual([]);
  });
});

describe('M6: the member notice names the real cause', () => {
  const B = { process: 'p-b', node: 'n-b', name: 'BRAVO' };
  const onShard = (shard: number, n: number, k: number) => String(((BigInt(k) * BigInt(n) + BigInt(shard)) << 22n) + 1n);
  const mapRow = (shard: number, n: number, holder: typeof B | null) => (holder
    ? { n, shard, holder_process: holder.process, holder_node: holder.node, holder_name: holder.name, claim: '1', released: false, reserved: false, ttl_ms: '30000', expires_up_ms: '90000', renewed_ago_ms: 10, up_ms: '1000', node_process_id: holder.process, node_takeover_seconds: 30, node_seen_ago_ms: 10 }
    : { n, shard, holder_process: null });
  const memberDeps = (over: Partial<MemberListDeps>, map: any[], outcome: Outcome = { k: 'reply', reply: { success: true, guilds: [] } }): MemberListDeps => ({
    localGuilds: async () => null,
    holderMap: async () => ({ rows: map, url: 'postgres://main' }),
    currentUrl: () => 'postgres://main',
    nodeId: () => 'n-a',
    membership: async () => outcome,
    ...over,
  });

  beforeEach(() => _resetMemberLists());

  it.each([
    ['the holder map cannot be read', { holderMap: async () => { throw new Error('connect ECONNREFUSED'); } }, [mapRow(0, 1, B)], undefined, MEMBER_NOTICES.noDatabase],
    ['no database address', { currentUrl: () => null, holderMap: async () => ({ rows: [mapRow(0, 1, B)] }) }, [], undefined, MEMBER_NOTICES.noDatabase],
    ['the send cannot reach the database', {}, [mapRow(0, 1, B)], { k: 'unreachable', cause: 'down' } as Outcome, MEMBER_NOTICES.noDatabase],
    ['no stored shard count', {}, [], undefined, MEMBER_NOTICES.noHolder],
    ['a shard with no holder', {}, [mapRow(0, 1, null)], undefined, MEMBER_NOTICES.noHolder],
    ['a holder that does not answer', {}, [mapRow(0, 1, B)], { k: 'no-answer', cause: 'timeout' } as Outcome, MEMBER_NOTICES.noAnswer],
  ] as const)('%s', async (_what, over, map, outcome, notice) => {
    const list = await memberServerList('m1', [onShard(0, 1, 3)], memberDeps(over as Partial<MemberListDeps>, map as unknown as any[], outcome as Outcome | undefined));
    expect(list.notice).toBe(notice);
  });

  it.each([
    [{ k: 'unreachable', cause: 'down' }, MEMBER_NOTICES.noDatabase],
    [{ k: 'maintenance' }, MEMBER_NOTICES.maintenance],
    [{ k: 'too-slow' }, MEMBER_NOTICES.tooSlow],
    [{ k: 'no-table' }, MEMBER_NOTICES.noTable],
    [{ k: 'insert-refused', code: '22001', message: 'value too long' }, MEMBER_NOTICES.insertRefused],
    [{ k: 'insecure' }, MEMBER_NOTICES.insecure],
    [{ k: 'exiting' }, MEMBER_NOTICES.shuttingDown],
    [{ k: 'withdrawn-at-exit' }, MEMBER_NOTICES.shuttingDown],
    [{ k: 'not-taken' }, MEMBER_NOTICES.notTaken],
    [{ k: 'withdrawn' }, MEMBER_NOTICES.withdrawn],
    [{ k: 'no-answer', cause: 'stopped' }, MEMBER_NOTICES.shuttingDown],
    [{ k: 'no-answer', cause: 'unsettled' }, MEMBER_NOTICES.unsettled],
    [{ k: 'no-answer', cause: 'lost' }, MEMBER_NOTICES.lost],
    [{ k: 'no-answer', cause: 'timeout' }, MEMBER_NOTICES.noAnswer],
    [{ k: 'reply', reply: { success: false, code: 'not-held' } }, MEMBER_NOTICES.notHeld],
    [{ k: 'reply', reply: { success: false, error: 'broke' } }, MEMBER_NOTICES.failed],
  ] as const)('the send outcome %o sets its own notice', async (outcome, notice) => {
    const list = await memberServerList('m1', [onShard(0, 1, 3)], memberDeps({}, [mapRow(0, 1, B)], outcome as unknown as Outcome));
    expect(list.notice).toBe(notice);
  });

  it('a send that rejects says the outcome is unknown; only a bot that took the request and did not answer gets the no-answer notice', async () => {
    const list = await memberServerList('m1', [onShard(0, 1, 3)], memberDeps({ membership: async () => { throw new Error('broke'); } }, [mapRow(0, 1, B)]));
    expect(list.notice).toBe(MEMBER_NOTICES.unknown);
    const sendKinds: Outcome['k'][] = ['maintenance', 'exiting', 'unreachable', 'too-slow', 'no-table', 'insert-refused', 'insecure', 'not-taken', 'withdrawn', 'withdrawn-at-exit'];
    for (const k of sendKinds) expect(memberNoticeOf({ k, cause: 'x', code: 'x', message: 'x' } as unknown as Outcome), k).not.toBe(MEMBER_NOTICES.noAnswer);
    expect(new Set(Object.values(MEMBER_NOTICES)).size).toBe(Object.values(MEMBER_NOTICES).length);
  });

  it('the notices say what they mean', () => {
    expect(MEMBER_NOTICES.noDatabase).toBe('Some servers could not be listed because the database could not be reached; reload to try again.');
    expect(MEMBER_NOTICES.noHolder).toBe('Some servers could not be listed because no machine runs them right now; reload in a moment.');
    expect(MEMBER_NOTICES.insecure).toBe('Some servers could not be listed because this web panel cannot send requests safely to the machine that runs them.');
    expect(MEMBER_NOTICES.tooSlow).toBe('Some servers could not be listed because the database answered too slowly; reload to try again.');
  });
});

describe("M2: a read's refusal with ran false is answered at once", () => {
  const URL1 = 'postgres://one';
  const down = { writerRoute: () => BOT_DOWN, isRunning: () => false } as any;
  let rig: Rig;
  let rows: Map<string, any>;

  beforeEach(() => {
    fakeTime();
    rig = nb7Rig();
    rig.server[URL1] = 's1';
    rows = new Map();
  });
  afterEach(() => resetNb7());

  function database(reply: Record<string, unknown>) {
    rig.script[URL1] = (sql, values) => {
      if (sql === REQUEST_INSERT_SQL) {
        rows.set(values[0] as string, { state: 'done', reply: JSON.stringify(reply), pickup_over: false, answer_over: false });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('WHERE id = $1') && !sql.includes('AND state')) {
        const r = rows.get(values[0] as string);
        return r ? { rows: [r] } : { rows: [] };
      }
      return undefined;
    };
  }

  async function start(op: 'guild:channels' | 'panel:button', body: Record<string, unknown>) {
    const plan = await planGuildRequest(down, GUILD, op, 'owner');
    const started = performance.now();
    let value: any;
    let at = -1;
    void runGuildRequest(plan, { ...body, actor: OWNER }, async () => ({})).then(v => { value = v; at = performance.now() - started; });
    return { get value() { return value; }, get at() { return at; } };
  }

  it("a channel list refused with ran false before claim_by passed is answered within a second; an action's refusal still waits", async () => {
    database({ success: false, ran: false, code: 'not-ready', error: 'The bot that runs this server has not yet learned whether its member web panel is on; nothing was run. Try again in a moment.' });
    const read = await start('guild:channels', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(read.value).toMatchObject({ status: 503, reply: { code: 'not-ready' } });
    expect(read.at).toBeLessThan(1000);
    const action = await start('panel:button', { panelId: 'p', buttonId: 'b', userId: 'web-ui-owner' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(action.value).toBeUndefined();
  });
});

describe('TX1: the note on left-out captured replies never says to run the command again', () => {
  it('says they were left out, and nothing more', () => {
    const too = PANEL_TEXTS.capturedOmitted('BRAVO', { count: 3, bytes: 300 * 1024, reason: 'too-large' });
    expect(too).toBe("On BRAVO: the command's 3 captured replies (300 KiB) are more than the 256 KiB one machine sends to another and are left out.");
    const odd = PANEL_TEXTS.capturedOmitted('BRAVO', { count: 1, bytes: 10, reason: 'unserializable' });
    expect(odd).toBe("On BRAVO: the command's 1 captured replies (1 KiB) cannot be passed between machines and are left out.");
    expect(`${too} ${odd}`).not.toMatch(/run it|console of/);
  });
});

describe("T-11: an 'unprotected' request client sends no statement at its connect", () => {
  beforeEach(() => { pgFake.sent = []; });

  it('no server identity is read until a statement runs on it; a local client reads it at the connect', async () => {
    const remote = _pgRequestDbForTests('postgresql://u:p@db.example:5432/d');
    const conn = await remote.connect(4000);
    expect(conn.transport).toBe('unprotected');
    expect(pgFake.sent).toEqual([]);
    expect(conn.server).toBeUndefined();
    await conn.query('SELECT 1', [], 4000);
    expect(pgFake.sent).toEqual([SERVER_IDENTITY_SQL, 'SELECT 1']);
    expect(conn.server).toBe('S1');
    conn.release();
    pgFake.sent = [];
    const here = _pgRequestDbForTests('postgresql://u:p@localhost:5432/d');
    const near = await here.connect(4000);
    expect(near.transport).toBe('local');
    expect(pgFake.sent).toEqual([SERVER_IDENTITY_SQL]);
    expect(near.server).toBe('S1');
    near.release();
    await Promise.all([remote.end(), here.end()]);
  });
});
