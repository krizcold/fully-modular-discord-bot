import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import type { RunBotOptions } from '../../src/bot/internalSetup/fleet/standbyBoot';
import type { StandbyTaken } from '../../src/bot/internalSetup/fleet/shardBoot';
import { l5Line, l6Line, l12Line, l12ReplacedLine, l22Line, l22PromotedLine } from '../../src/bot/internalSetup/fleet/shardClaims';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, ENTRY, FakeChannel, claimRow, T, gatewayAnswer, lineLog, markDone, standbyEnv, standbyStore } from '../helpers/standbyRig';

// NB9 test 5 (27 to 30, 42, 44, 45, 49, 54 and C3) with test 3's standby cells on the bot side: standbyMain() over the
// claims fake, a recording IPC channel and a stubbed login. The facade's stop steps, decideBoot, the data layer and the
// shard record are recorders; the IngestService, ShardClaims and LeaseRuntime are the real ones.

const h = vi.hoisted(() => ({
  order: [] as string[],
  stopSteps: [] as Array<() => Promise<void>>,
  releaseSteps: [] as Array<() => Promise<void>>,
  decideBoot: 0,
  initDataBackendLayer: 0,
  records: [] as unknown[],
}));

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'n-a',
  getNodeName: () => 'A',
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: (step: () => Promise<void>) => { h.order.push('stop step'); h.stopSteps.push(step); },
  addReleaseStep: (step: () => Promise<void>) => { h.order.push('release step'); h.releaseSteps.push(step); },
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  decideBoot: async () => { h.decideBoot += 1; return { mode: 'normal' }; },
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  initDataBackendLayer: () => { h.initDataBackendLayer += 1; },
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: (record: unknown) => { h.records.push(record); },
}));

const capacity = process.env.FLEET_SHARD_CAPACITY;
beforeEach(() => {
  h.order.length = 0;
  h.stopSteps.length = 0;
  h.releaseSteps.length = 0;
  h.decideBoot = 0;
  h.initDataBackendLayer = 0;
  h.records.length = 0;
  process.env.FLEET_SHARD_CAPACITY = '8';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (capacity === undefined) delete process.env.FLEET_SHARD_CAPACITY;
  else process.env.FLEET_SHARD_CAPACITY = capacity;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const emit = (client: Client, event: string, ...args: unknown[]) =>
  (client.emit as unknown as (event: string, ...args: unknown[]) => boolean).call(client, event, ...args);

interface BootOpts {
  store?: MemClaimStore;
  env?: Record<string, string | undefined>;
  gateway?: () => Promise<any>;
  channel?: FakeChannel | null;
  slots?: boolean;
}

async function boot(o: BootOpts = {}) {
  vi.resetModules();
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
  const ingest = getIngestService();
  const store = o.store ?? standbyStore();
  const reserved: Array<[number, string]> = [];
  if (o.slots) {
    (store as any).reserveIdentifySlot = async (bucket: number, holder: string) => { reserved.push([bucket, holder]); return { granted: true }; };
  }
  const renew = store.renewStandby.bind(store);
  store.renewStandby = request => { h.order.push('renewal'); return renew(request); };
  const take = store.standbyTake.bind(store);
  store.standbyTake = (request, onBegin) => { h.order.push('take'); return take(request, onBegin); };
  const work = store.withWorkClient.bind(store);
  store.withWorkClient = ((what: string, fn: any) => { if (what === 'the login budget') h.order.push('budget read'); return work(what, fn); }) as typeof store.withWorkClient;
  const logins: Array<string | undefined> = [];
  ingest.start = (async (token: string | undefined) => { h.order.push('login'); logins.push(token); return ''; }) as typeof ingest.start;
  const build = ingest.buildClient.bind(ingest);
  ingest.buildClient = ((options: any, hook?: any) => { h.order.push('client'); return build(options, hook); }) as typeof ingest.buildClient;
  const throttlers: unknown[] = [];
  const setThrottler = ingest.setIdentifyThrottler.bind(ingest);
  ingest.setIdentifyThrottler = build2 => { throttlers.push(build2); setThrottler(build2); };
  const channel = o.channel === undefined ? new FakeChannel() : o.channel;
  const { lines, log } = lineLog();
  const runs: RunBotOptions[] = [];
  const entries: string[] = [];
  let stops = 0;
  const gateway = o.gateway ?? (async () => gatewayAnswer(900));
  await sb.standbyMain({
    env: o.env ?? standbyEnv(),
    storeFactory: entry => { h.order.push('pool'); entries.push(entry); return store; },
    channel,
    gateway: async () => { h.order.push('gateway'); return gateway(); },
    takeLock: async () => { h.order.push('lock'); },
    runBot: async opts => { h.order.push('runBot'); runs.push(opts); },
    stop: () => { stops += 1; },
    log,
  });
  return { sb, ingest, store, channel: channel as FakeChannel, lines, runs, entries, logins, throttlers, reserved, processId: processId(), stops: () => stops };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** 'done' read by the 1 s poll. */
async function done(r: Booted): Promise<void> {
  markDone(r.store);
  await tick(1000);
}

function promote(r: Booted): void {
  r.channel.deliver({ type: 'reshard:promoted' });
}

describe('test 5: the standby before it serves (27, 42, 44, 45)', () => {
  it('takes no lock, runs no decideBoot and no data layer, writes no shard record and sends no data:store; its claims pool is on SMDB_RESHARD_DB', async () => {
    const r = await boot();
    await done(r);
    await tick(10_000);
    expect(h.order).not.toContain('lock');
    expect(h.decideBoot).toBe(0);
    expect(h.initDataBackendLayer).toBe(0);
    expect(h.records).toEqual([]);
    expect(r.channel.of('data:store')).toEqual([]);
    expect(r.entries).toEqual([ENTRY]);
    expect(r.runs).toEqual([]);
  });

  it('answers only its own IPC types: a panel, fleet or data request gets no answer', async () => {
    const r = await boot();
    for (const type of ['panel:list', 'fleet:state', 'data:guild-read', 'command:invoke']) r.channel.deliver({ type, requestId: `q-${type}` });
    await tick(10);
    for (const type of ['panel:list', 'fleet:state', 'data:guild-read', 'command:invoke']) expect(r.channel.answers(`q-${type}`)).toEqual([]);
  });

  it('runs in order: the gateway stop step, the pool and its pre-serve release step, the first renewal, the take (L5), the budget, the Client, the login', async () => {
    const r = await boot({ slots: true });
    expect(h.order).toEqual(['stop step', 'pool', 'release step', 'renewal', 'take', 'budget read', 'gateway', 'client', 'login']);
    expect(r.lines).toEqual([l5Line(8, [0, 1, 2, 3, 4, 5, 6, 7])]);
    expect(r.logins).toEqual(['token-standby']);
  });

  it("builds the Client with the env's intents, its rows under W and the database slot throttler under its process id", async () => {
    const r = await boot({ slots: true });
    const client = r.ingest.getClient()!;
    expect(Number(client.options.intents.bitfield)).toBe(1 | 512);
    expect(r.ingest.getShardPlan()).toEqual({ shards: [0, 1, 2, 3, 4, 5, 6, 7], shardCount: 8 });
    expect(r.throttlers).toHaveLength(1);
    const throttler = await (r.throttlers[0] as (m: object) => Promise<any>)({ fetchGatewayInformation: async () => ({ session_start_limit: { max_concurrency: 1 } }) });
    await throttler.waitForIdentify(3, new AbortController().signal);
    expect(r.reserved).toEqual([[0, r.processId]]);
  });

  it("tracks readiness: 'shardReady' and 'shardResume' ready, 'shardDisconnect' and 'shardReconnecting' not; progress at each change and L6 once", async () => {
    const r = await boot();
    const client = r.ingest.getClient()!;
    for (let s = 0; s < 8; s++) emit(client, 'shardReady', s, new Set());
    emit(client, 'shardDisconnect', { code: 1000 }, 2);
    emit(client, 'shardReconnecting', 5);
    emit(client, 'shardResume', 2, 0);
    const progress = r.channel.of('reshard:standby-progress').map(m => m.data);
    expect(progress[0]).toEqual({ attempt: AT, held: 8, ready: 0 });
    expect(progress.slice(-4).map(p => p.ready)).toEqual([8, 7, 6, 7]);
    expect(r.lines.filter(l => l === l6Line(8))).toHaveLength(1);
    await tick(T.renewMs);
    expect(r.store.standbyRenewals.at(-1)!.pairs.map(p => [p.shardId, p.ready])).toEqual([[0, true], [1, true], [2, true], [3, true], [4, true], [5, false], [6, true], [7, true]]);
  });

  it('a take with no row builds no Client and reads no /gateway/bot; its serve hands runBot no Client and no pairs (44)', async () => {
    const store = standbyStore();
    // Another machine's standby already holds every row of W.
    const B = { processId: 'p-b-standby', nodeId: 'n-b', nodeName: 'B' };
    for (let s = 0; s < 8; s++) store.rows.set(`8:${s}`, claimRow(8, s, B));
    store.nodes.set(B.nodeId, { ...store.nodes.get('n-a')!, nodeId: B.nodeId, nodeName: B.nodeName, processId: 'p-b-old' });
    const r = await boot({ store });
    expect(r.ingest.getClient()).toBeNull();
    expect(h.order).not.toContain('gateway');
    expect(h.order).not.toContain('budget read');
    await done(r);
    promote(r);
    await tick(1);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0].client).toBeUndefined();
    expect((r.runs[0].taken as StandbyTaken).pairs).toEqual([]);
  });

  it("'disconnect' of the IPC channel runs the stop handler", async () => {
    const r = await boot();
    r.channel.emit('disconnect');
    expect(r.stops()).toBe(1);
  });
});

describe("test 5: the standby's maintenance answers (27, D3)", () => {
  it("'maintenance:enter' answers { saved: true }; 'maintenance:leave' answers and asks for the restart with L22's promoted form", async () => {
    const r = await boot();
    r.channel.deliver({ type: 'maintenance:enter', requestId: 'm1', data: { message: 'Back soon.' } });
    expect(r.channel.answers('m1')).toEqual([{ requestId: 'm1', data: { saved: true } }]);
    r.channel.deliver({ type: 'maintenance:leave', requestId: 'm2' });
    expect(r.channel.answers('m2')).toEqual([{ requestId: 'm2', data: { leaving: true } }]);
    expect(r.channel.of('control:restart-bot')).toEqual([{ type: 'control:restart-bot', data: { reason: 'the bot left maintenance' } }]);
    expect(r.lines.at(-1)).toBe(l22PromotedLine('the bot left maintenance'));
    expect(r.stops()).toBe(0);
  });

  it('after endStandbyMaintenanceAnswers neither is answered, and the other types stay', async () => {
    const r = await boot();
    r.sb.endStandbyMaintenanceAnswers();
    r.channel.deliver({ type: 'maintenance:enter', requestId: 'm3' });
    r.channel.deliver({ type: 'maintenance:leave', requestId: 'm4' });
    expect(r.channel.answers('m3')).toEqual([]);
    expect(r.channel.answers('m4')).toEqual([]);
    expect(r.channel.of('control:restart-bot')).toEqual([]);
    await done(r);
    promote(r);
    await tick(1);
    expect(r.runs).toHaveLength(1);
  });
});

describe('test 5: the serve (28, 30, 54)', () => {
  for (const first of ['done', 'promoted'] as const) {
    it(`serves only after both 'done' and 'reshard:promoted' (${first} first): the lock, then runBot with taken and the Client`, async () => {
      const r = await boot();
      if (first === 'done') await done(r); else promote(r);
      await tick(5000);
      expect(r.runs).toEqual([]);
      if (first === 'done') promote(r); else await done(r);
      await tick(1);
      expect(h.order.slice(-2)).toEqual(['lock', 'runBot']);
      const taken = r.runs[0].taken as StandbyTaken;
      expect(taken.count).toBe(8);
      expect(taken.processId).toBe(r.processId);
      expect(taken.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(taken.runtime.getCurrent()?.leases.map(l => l.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(r.runs[0].client).toBe(r.ingest.getClient());
    });
  }

  it("300 s after 'done' with no promotion: the handshake of kind 'failed' and no line before the answer; false: L29, then the stop", async () => {
    const r = await boot();
    await done(r);
    const before = r.lines.length;
    await tick(300_000);
    expect(r.channel.of('reshard:standby-stopping')).toEqual([{ type: 'reshard:standby-stopping', data: { attempt: AT, reason: 'the old bot process has not stopped', kind: 'failed' } }]);
    await tick(5000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(2);
    expect(r.lines.length).toBe(before);
    expect(r.stops()).toBe(0);
    r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: false } });
    await tick(1);
    expect(r.lines.slice(before)).toEqual(["[Shards] The reshard to 8 shards was done 5 min ago, but this machine's old bot process has not stopped; this standby process stops"]);
    expect(r.stops()).toBe(1);
    expect(r.runs).toEqual([]);
  });

  it("the serve wait answered true after 'reshard:promoted': it serves and asks for no restart (54)", async () => {
    const r = await boot();
    await done(r);
    await tick(300_000);
    promote(r);
    r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: true } });
    await tick(1);
    expect(r.runs).toHaveLength(1);
    expect(r.channel.of('control:restart-bot')).toEqual([]);
    expect(r.stops()).toBe(0);
  });

  it('the 1 s poll runs before the promotion and stops at taken.stopLanes() (45)', async () => {
    const r = await boot();
    await done(r);
    promote(r);
    await tick(1);
    const polled = r.store.workStatements.length;
    await tick(3000);
    expect(r.store.workStatements.length).toBeGreaterThan(polled);
    await (r.runs[0].taken as StandbyTaken).stopLanes();
    const stopped = r.store.workStatements.length;
    await tick(5000);
    expect(r.store.workStatements.length).toBe(stopped);
  });
});

describe('test 5: the self-stops and their handshake (30, 49, E7, E8)', () => {
  const cases = [
    {
      name: 'the attempt called off', kind: 'called-off',
      end: (s: MemClaimStore) => { s.reshard = { ...s.reshard, state: 'cancelled' }; s.attemptRow = { ...s.attemptRow, reason: 'B is not healthy' }; },
      reason: 'B is not healthy', line: l12Line(8, 'B is not healthy'),
    },
    {
      name: 'the attempt replaced', kind: 'called-off',
      end: (s: MemClaimStore) => { s.reshard = { ...s.reshard, attempt: 'a1b2c3d4-0000-4000-8000-0000000000c5', toCount: 6 }; },
      reason: 'a reshard to 6 shards has started in its place', line: l12ReplacedLine(8, 6),
    },
    {
      name: 'no attempt in the row (E8)', kind: 'called-off',
      end: (s: MemClaimStore) => { s.reshard = { ...s.reshard, attempt: null, state: null, fromCount: null, toCount: null }; },
      reason: 'the database no longer records it',
      line: '[Shards] The reshard to 8 shards has ended: the database no longer records it; this standby process stops',
    },
  ];
  for (const c of cases) {
    it(`${c.name}: the handshake of kind '${c.kind}'; false: L12's form, then the stop`, async () => {
      const r = await boot();
      c.end(r.store);
      await tick(1000);
      expect(r.channel.of('reshard:standby-stopping')).toEqual([{ type: 'reshard:standby-stopping', data: { attempt: AT, reason: c.reason, kind: c.kind } }]);
      expect(r.stops()).toBe(0);
      r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: false } });
      await tick(1);
      expect(r.lines.at(-1)).toBe(c.line);
      expect(r.stops()).toBe(1);
    });
  }

  it("a lapse: the handshake of kind 'failed'; false: L22, then the stop", async () => {
    const r = await boot();
    r.store.renewMode = new Error('connection refused');
    await tick(T.deadlineMs + T.renewMs);
    const stopping = r.channel.of('reshard:standby-stopping');
    expect(stopping.length).toBeGreaterThan(0);
    expect(new Set(stopping.map(m => JSON.stringify(m))).size).toBe(1);
    expect(stopping[0].data.kind).toBe('failed');
    const cause: string = stopping[0].data.reason;
    expect(cause).toMatch(/^no claim renewal for \d+ s$/);
    r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: false } });
    await tick(1);
    expect(r.lines.at(-1)).toBe(l22Line(cause));
    expect(r.stops()).toBe(1);
  });

  it("a lapse answered true: L22's promoted form and 'control:restart-bot', asked again every 60 s; no stop of its own", async () => {
    const r = await boot();
    r.store.renewMode = new Error('connection refused');
    await tick(T.deadlineMs + T.renewMs);
    const cause: string = r.channel.of('reshard:standby-stopping')[0].data.reason;
    r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: true } });
    await tick(1);
    expect(r.lines.at(-1)).toBe(l22PromotedLine(cause));
    expect(r.channel.of('control:restart-bot')).toEqual([{ type: 'control:restart-bot', data: { reason: cause } }]);
    await tick(60_000);
    expect(r.channel.of('control:restart-bot')).toHaveLength(2);
    expect(r.lines.at(-1)).toBe('[Maintenance] The bot process still runs 60 s after asking for its restart; asking again');
    expect(r.stops()).toBe(0);
  });

  it('with no IPC channel the self-stop stops at once, with its line', async () => {
    const r = await boot({ channel: null });
    r.store.reshard = { ...r.store.reshard, state: 'cancelled' };
    r.store.attemptRow = { ...r.store.attemptRow, reason: 'B is not healthy' };
    await tick(1000);
    expect(r.lines.at(-1)).toBe(l12Line(8, 'B is not healthy'));
    expect(r.stops()).toBe(1);
  });
});

describe("test 5: what runBot gets to release (42, C3, C5)", () => {
  async function served() {
    const r = await boot();
    await done(r);
    promote(r);
    await tick(1);
    return r;
  }

  it('releaseInjected closes the gateway, writes the shard record under W with the pairs, releases on the pre-serve lanes; a later claimsStop releases nothing', async () => {
    const r = await served();
    const closes: string[] = [];
    const close = r.ingest.close.bind(r.ingest);
    r.ingest.close = async reason => { closes.push(reason); return close(reason); };
    await r.runs[0].releaseInjected!();
    expect(closes).toEqual(['shutting down']);
    expect(h.records).toEqual([expect.objectContaining({ shardCount: 8, shardIds: [0, 1, 2, 3, 4, 5, 6, 7], processId: r.processId })]);
    expect(r.store.releases).toHaveLength(1);
    expect(r.store.releases[0].me.processId).toBe(r.processId);
    expect(r.sb.claimsPhase()).toBe('released');
    await r.sb.claimsStop('pre-serve');
    await r.sb.claimsStop('serving');
    expect(r.store.releases).toHaveLength(1);
  });

  it("taken.release closes the Client, then releases on the pre-serve lanes (C5); the phase is 'released'", async () => {
    const r = await served();
    const order: string[] = [];
    r.ingest.close = async () => { order.push('close'); };
    const release = r.store.release.bind(r.store);
    r.store.release = (request, onSent, onConnected) => { order.push('release'); return release(request, onSent, onConnected); };
    await (r.runs[0].taken as StandbyTaken).release();
    expect(order).toEqual(['close', 'release']);
    expect([...r.store.rows.values()].filter(x => x.shardCount === 8).every(x => x.released)).toBe(true);
    expect(r.sb.claimsPhase()).toBe('released');
  });

  it("before onServing the 'pre-serve' step releases; after it the 'pre-serve' step does nothing", async () => {
    const r = await served();
    expect(r.sb.claimsPhase()).toBe('pre-serve');
    const taken = r.runs[0].taken as StandbyTaken;
    taken.onServing!();
    expect(r.sb.claimsPhase()).toBe('serving');
    await r.sb.claimsStop('pre-serve');
    expect(r.store.releases).toEqual([]);
  });

  it("C10 (code review 1, B3): after onServing, the throttler built before the serve reserves through the serve store's reserve", async () => {
    const r = await boot({ slots: true });
    await done(r);
    promote(r);
    await tick(1);
    const taken = r.runs[0].taken as StandbyTaken;
    const serve: Array<[number, string]> = [];
    taken.onServing!(async (bucket, holder) => { serve.push([bucket, holder]); return { granted: true }; });
    const throttler = await (r.throttlers[0] as (m: object) => Promise<any>)({ fetchGatewayInformation: async () => ({ session_start_limit: { max_concurrency: 1 } }) });
    await throttler.waitForIdentify(3, new AbortController().signal);
    expect(serve).toEqual([[0, r.processId]]);
    expect(r.reserved).toEqual([]);
  });
});

describe('test 5: a JSON standby (15)', () => {
  it("logs in every shard of W with the web UI's slots, says when all are ready, and serves at 'reshard:promoted' with a JSON taken", async () => {
    const r = await boot({ env: standbyEnv({ SMDB_RESHARD_DB: undefined, SMDB_RESHARD_COUNT: '3' }) });
    expect(r.entries).toEqual([]);
    expect(r.ingest.getShardPlan()).toEqual({ shards: [0, 1, 2], shardCount: 3 });
    expect(r.logins).toEqual(['token-standby']);
    const throttler = await (r.throttlers[0] as (m: object) => Promise<any>)({ fetchGatewayInformation: async () => ({ session_start_limit: { max_concurrency: 1 } }) });
    const waited = throttler.waitForIdentify(0, new AbortController().signal);
    await tick(1);
    const ask = r.channel.of('identify:slot')[0];
    expect(ask.data.bucket).toBe(0);
    r.channel.deliver({ type: 'identify:slot', data: { nonce: ask.data.nonce, waitMs: 0 } });
    await waited;
    const client = r.ingest.getClient()!;
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardReady', 1, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([]);
    emit(client, 'shardReady', 2, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([{ type: 'reshard:standby-ready', data: { attempt: AT } }]);
    promote(r);
    await tick(1);
    expect(r.runs[0].taken).toMatchObject({ json: true, count: 3 });
    expect(r.runs[0].client).toBe(client);
    expect(r.sb.claimsPhase()).toBe('serving');
  });

  it("15 (code review 1, B4): the JSON taken carries SMDB_RESHARD_FROM as from, and none when the web UI sent none", async () => {
    for (const [from, want] of [['1', 1], [undefined, undefined], ['x', undefined]] as const) {
      const r = await boot({ env: standbyEnv({ SMDB_RESHARD_DB: undefined, SMDB_RESHARD_COUNT: '3', SMDB_RESHARD_FROM: from }) });
      promote(r);
      await tick(1);
      expect((r.runs[0].taken as { from?: number }).from).toBe(want);
    }
  });
});
