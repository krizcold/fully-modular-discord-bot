import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import {
  _resetMaintenance, _setMaintenanceSender, _setMaintenanceTiming, markDiscordStarted, restartForShards, startLeave, watchDataBackend,
} from '../../src/bot/internalSetup/utils/maintenance';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { Reshard } from '../../src/bot/internalSetup/fleet/reshard';
import { claimTimings, type ClaimRow } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore, tokenFor } from '../helpers/fakeStore';

// NB9 test 4: the hand-over (9, 25, 48) and its leave (C8). The leave rows drive NB2's real leave over a real working
// set; the hand-over rows run a serving ShardClaims over the claims fake with NB9's driver on its page reads, from rows
// NB4's take writes and states decision 6's start, 8's flip and 10's close leave in the reshard row.

const AT = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const T = claimTimings(30);
const sent: any[] = [];
const logs: string[] = [];
let guilds = 9_400_000;
const realSend = process.send;

beforeEach(() => {
  _resetMaintenance();
  sent.length = 0;
  logs.length = 0;
  _setMaintenanceSender(message => { sent.push(message); });
  _setMaintenanceTiming({ leaveRetryMs: 30, filePollMs: 600_000, restartResendMs: 60_000, leaveSaveBoundMs: 100, heldAfterPasses: 2 });
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  _resetMaintenance();
  _setMaintenanceSender(null);
  setBackendKind(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function storeRig() {
  setBackendKind('postgres');
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  const add = async () => {
    const g = String(++guilds);
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    return g;
  };
  return { store, ws, add };
}

async function dirty(r: ReturnType<typeof storeRig>, code: () => string | null = () => null) {
  const g = await r.add();
  const prior = r.store.flushGuild;
  r.store.flushGuild = (async (guildId: string, batch: unknown, token: unknown) => guildId === g
    ? (code() ? { ok: false, reason: 'unavailable', code: code() } : { ok: false, reason: 'unavailable', detail: 'Connection refused' })
    : prior.call(r.store, guildId, batch as never, token as never)) as typeof prior;
  saveData('h.json', { guildId: g, category: 'm' }, { v: 1 });
  return g;
}

async function unansweredOnly(r: ReturnType<typeof storeRig>) {
  const g = await r.add();
  saveData('a.json', { guildId: g, category: 'm' }, { v: 1 });
  r.store.mode = 'landed-unanswered';
  expect(await r.ws.flushGuildNow(g, 50)).toBe('pending');
  r.store.mode = 'commit';
  r.store.checkMode = 'unknown';
  return g;
}

const L8 = 'Resharding to 8 shards: this process hands its shards to the new ones';
const heldLine = (part: string) => logs.find(l => l.startsWith('[Maintenance]') && l.includes(part));

describe("C8: the leave's hand-over forms (H1 to H4) and its end", () => {
  it('H1, then the retire with its line, re-sent with its line after 60 s', async () => {
    vi.useFakeTimers();
    storeRig();
    startLeave(L8, { attempt: AT });
    expect(logs[0]).toBe(`[Maintenance] ${L8}; saving what this process holds before it stops and the bot process for the new shards takes over`);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.filter(m => m.type === 'control:reshard-retire')).toEqual([{ type: 'control:reshard-retire', data: { attempt: AT } }]);
    expect(sent.some(m => m.type === 'control:restart-bot')).toBe(false);
    expect(logs).toContain(`[Maintenance] ${L8}; asking the web UI process to stop this bot process and run the one for the new shards`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.filter(m => m.type === 'control:reshard-retire')).toHaveLength(2);
    expect(logs).toContain('[Maintenance] The bot process still runs 60 s after asking to hand over; asking again');
  });

  it('H3 after one pass refused for content, then H2 and the retire', async () => {
    const r = storeRig();
    let code: string | null = null;
    const g = await dirty(r, () => code);
    // The content path needs the watcher's answer that the database answers (NB2 decision 11).
    const watcher = watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' } as never, { retryMs: 3_600_000 })!;
    markDiscordStarted();
    await watcher.probeNow();
    startLeave(L8, { attempt: AT });
    await vi.waitFor(() => expect(heldLine('left changes unsaved')).toBeDefined(), { timeout: 5000 });
    code = '23503';
    await vi.waitFor(() => expect(heldLine('refuses these for their content')).toBeDefined(), { timeout: 5000 });
    expect(heldLine('refuses these for their content')!.endsWith('the database refuses these for their content; the bot process keeps running, and after 2 saves in a row that fail this way it stops for the hand-over and drops them')).toBe(true);
    await vi.waitFor(() => expect(sent.some(m => m.type === 'control:reshard-retire')).toBe(true), { timeout: 5000 });
    const h2 = heldLine('refuses for their content')!;
    expect(h2.startsWith(`[Maintenance] 2 saves in a row left changes the database refuses for their content: guild ${g} (`)).toBe(true);
    expect(h2.endsWith('; the bot process stops for the hand-over, which drops these changes')).toBe(true);
  });

  it('H4 with an unsaved guild', async () => {
    const r = storeRig();
    await dirty(r);
    startLeave(L8, { attempt: AT });
    await vi.waitFor(() => expect(heldLine('left changes unsaved')).toBeDefined(), { timeout: 5000 });
    expect(heldLine('left changes unsaved')!.endsWith('the bot process keeps running and does not stop for the hand-over until they are saved or the operator stops it, which drops them')).toBe(true);
    expect(sent.some(m => m.type === 'control:reshard-retire')).toBe(false);
  });

  it('H4 with an unanswered guild', async () => {
    const r = storeRig();
    await unansweredOnly(r);
    startLeave(L8, { attempt: AT });
    await vi.waitFor(() => expect(heldLine('holding only a save')).toBeDefined(), { timeout: 5000 });
    expect(heldLine('holding only a save')!.endsWith('the bot process keeps running and does not stop for the hand-over until they are saved or found stored or the operator stops it, which drops every change not stored')).toBe(true);
    r.store.checkMode = 'answer';
  });

  it('H4 with a restart asked earlier', async () => {
    const r = storeRig();
    await unansweredOnly(r);
    expect(restartForShards('take shard 1', () => null)).toBe(true);
    startLeave(L8, { attempt: AT });
    await vi.waitFor(() => expect(heldLine('holding only a save')).toBeDefined(), { timeout: 5000 });
    expect(heldLine('holding only a save')!.endsWith('does not stop for the hand-over until they are saved or found stored or the operator stops it, which drops every change not stored; a restart this process asked for earlier may still stop it, which drops every change not stored')).toBe(true);
    r.store.checkMode = 'answer';
  });

  it('a hand-over with no IPC channel logs the landed stop forms', async () => {
    (process as { send?: unknown }).send = undefined;
    _setMaintenanceSender(null);
    const r = storeRig();
    await dirty(r);
    startLeave(L8, { attempt: AT });
    expect(logs[0]).toBe(`[Maintenance] ${L8}; saving what this process holds before it stops (no web UI process runs to restart it)`);
    await vi.waitFor(() => expect(heldLine('left changes unsaved')).toBeDefined(), { timeout: 5000 });
    expect(heldLine('left changes unsaved')!.endsWith('the bot process keeps running and does not stop until they are saved or the operator stops it, which drops them')).toBe(true);
  });
});

// ---------------------------------------------------------------- the hand-over at a page read

const A = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };

function row(shardCount: number, shardId: number, holder = A, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount, shardId, claim: 100 + shardCount * 10 + shardId, holderProcess: holder.processId, holderNode: holder.nodeId,
    holderName: holder.nodeName, homeNode: holder.nodeId, released: false, reserved: false, takenAt: 0, renewedAt: 0,
    ttlMs: T.ttlMs, expiresUpMs: 10_000_000, extended: false, ...over,
  };
}

async function servingA(opts: { granted?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  storeRig();
  const store = new MemClaimStore(() => Date.now());
  const events: string[] = [];
  const leaves: Array<{ reason: string; handOver?: { attempt: string | null } }> = [];
  let driver: Reshard | null = null;
  const claims = new ShardClaims({
    store, me: A, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => { events.push('stop-serving'); },
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null,
    onPage: page => driver?.onPage(page),
  });
  driver = new Reshard({
    claims, withWorkClient: (what, fn) => store.withWorkClient(what, fn), me: A, fitness: () => null, restartable: true,
    startLeave: (reason, handOver) => {
      events.push('leave');
      leaves.push({ reason, handOver });
      startLeave(reason, handOver);
    },
    send: m => { sent.push(m); }, intents: () => 1, maxConcurrency: () => 1, entry: () => 'db', budget: () => null,
    recommendation: () => null,
  });
  store.count = 4;
  claims.start();
  await claims.firstRenewal();
  const taken = await claims.bootTake(async () => 4);
  expect(taken?.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3]);
  if (opts.granted !== false) claims.noteGranted();
  return { store, claims, driver, events, leaves };
}

const flipTo8 = (store: MemClaimStore, state: 'flipped' | 'done' | null) => {
  store.count = 8;
  store.reshard = state === null
    ? { attempt: null, state: null, fromCount: null, toCount: null }
    : { attempt: AT, state, fromCount: 4, toCount: 8 };
};

describe('the hand-over (9, 25, 48)', () => {
  it("at the page read that shows the flip: NB4's stop-serving step and NB2's leave with L8 in one synchronous step, the retire with the attempt, then H5 and the close at the release", async () => {
    const r = await servingA();
    for (let s = 0; s < 8; s++) r.store.rows.set(`8:${s}`, row(8, s, { processId: 'p-standby', nodeId: 'n-a', nodeName: 'A' }));
    flipTo8(r.store, 'flipped');
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.events).toEqual(['stop-serving', 'leave']);
    expect(r.leaves).toEqual([{ reason: L8, handOver: { attempt: AT } }]);
    expect(r.claims.stoppedServing()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter(m => m.type === 'control:reshard-retire')).toEqual([{ type: 'control:reshard-retire', data: { attempt: AT } }]);
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    expect(r.events).toEqual(['stop-serving', 'leave']);
    await r.claims.finishStop();
    expect(logs).toContain('[Shards] Released the old shard(s) 0, 1, 2, 3 of the 4-shard set: the 8 new shards take their servers once every old shard is released');
    expect(logs.some(l => l.startsWith('[Shards] Released shards'))).toBe(false);
    expect(r.store.reshard.state).toBe('done');
    expect([...r.store.rows.values()].some(x => x.shardCount === 4)).toBe(false);
    expect(logs).toContain("[Shards] The 4 old shards are released; each machine's new shards serve once its old bot process has stopped");
  });

  it.each([
    ["'done'", 'done' as const, AT],
    ['no attempt open (a direct change)', null, null],
  ])('fires in %s', async (_name, state, attempt) => {
    const r = await servingA();
    flipTo8(r.store, state);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.leaves).toEqual([{ reason: L8, handOver: { attempt } }]);
  });

  it("not while this process holds a live row of meta's count", async () => {
    const r = await servingA();
    flipTo8(r.store, 'flipped');
    r.store.rows.set('8:0', row(8, 0));
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    expect(r.leaves).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it('never in a boot that waits (no grant yet)', async () => {
    const r = await servingA({ granted: false });
    flipTo8(r.store, 'flipped');
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    expect(r.leaves).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it("12: a 'stopping' attempt from this count runs the stop-serving step and NB2's leave with L26, ending in the restart", async () => {
    const r = await servingA();
    r.store.reshard = { attempt: AT, state: 'stopping', fromCount: 4, toCount: 8 };
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.events).toEqual(['stop-serving', 'leave']);
    expect(r.leaves).toEqual([{ reason: 'Resharding to 8 shards by stopping and starting every machine', handOver: undefined }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.some(m => m.type === 'control:restart-bot')).toBe(true);
    expect(sent.some(m => m.type === 'control:reshard-retire')).toBe(false);
  });
});
