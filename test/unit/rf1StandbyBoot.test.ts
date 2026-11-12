import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

import { l12Line, l22PromotedLine } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, FakeChannel, claimRow, gatewayAnswer, lineLog, standbyEnv, standbyStore } from '../helpers/standbyRig';

const h = vi.hoisted(() => ({
  stopping: false,
  beginStops: 0,
}));

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'n-a',
  getNodeName: () => 'A',
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: () => undefined,
  addReleaseStep: () => undefined,
  isStopping: () => h.stopping,
  beginStop: async () => { h.beginStops += 1; },
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: () => undefined,
}));

const capacity = process.env.FLEET_SHARD_CAPACITY;
beforeEach(() => {
  h.stopping = false;
  h.beginStops = 0;
  process.env.FLEET_SHARD_CAPACITY = '8';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  if (capacity === undefined) delete process.env.FLEET_SHARD_CAPACITY;
  else process.env.FLEET_SHARD_CAPACITY = capacity;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const emit = (client: Client, event: string, ...args: unknown[]) =>
  (client.emit as unknown as (event: string, ...args: unknown[]) => boolean).call(client, event, ...args);

interface BootOpts {
  env?: Record<string, string | undefined>;
  store?: MemClaimStore;
  gateway?: () => Promise<any>;
  noStopDep?: boolean;
  callOffError?: Error;
}

async function boot(o: BootOpts = {}) {
  vi.resetModules();
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const ingest = getIngestService();
  const store = o.store ?? standbyStore();
  const work = store.withWorkClient.bind(store);
  let gatewayAnswered = false;
  let failNext = o.callOffError ?? null;
  store.withWorkClient = ((what: string, fn: any) => {
    if (gatewayAnswered && failNext) {
      const error = failNext;
      failNext = null;
      return Promise.reject(error);
    }
    return work(what, fn);
  }) as typeof store.withWorkClient;
  const logins: Array<string | undefined> = [];
  ingest.start = (async (token: string | undefined) => { logins.push(token); return ''; }) as typeof ingest.start;
  const throttlers: unknown[] = [];
  const setThrottler = ingest.setIdentifyThrottler.bind(ingest);
  ingest.setIdentifyThrottler = build => { throttlers.push(build); setThrottler(build); };
  const channel = new FakeChannel();
  const { lines, log } = lineLog();
  let stops = 0;
  let gatewayReads = 0;
  const gateway = o.gateway ?? (async () => gatewayAnswer(900));
  let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
  let failure: unknown = null;
  const run = sb.standbyMain({
    env: o.env ?? standbyEnv(),
    storeFactory: () => store,
    channel,
    gateway: async () => { gatewayReads += 1; const answered = await gateway(); gatewayAnswered = true; return answered; },
    takeLock: async () => undefined,
    runBot: async () => undefined,
    ...(o.noStopDep ? {} : { stop: () => { stops += 1; } }),
    log,
  }).then(() => { settled = 'resolved'; }, error => { settled = 'rejected'; failure = error; });
  return {
    sb, ingest, store, channel, lines, logins, throttlers, run,
    stops: () => stops, gatewayReads: () => gatewayReads, settled: () => settled, failure: () => failure,
  };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function until(r: Booted, cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick(1);
  if (!cond()) throw new Error(`[Test] ${what} did not happen`);
}

function readyElsewhere(store: MemClaimStore, ids: number[]): void {
  const C = { processId: 'p-C', nodeId: 'n-C', nodeName: 'C' };
  for (const s of ids) {
    store.rows.set(`8:${s}`, claimRow(8, s, C, { renewedAt: Date.now() }));
    store.ready.set(`8:${s}`, true);
  }
  store.nodes.set(C.nodeId, { ...store.nodes.get('n-a')!, nodeId: C.nodeId, nodeName: 'C', processId: C.processId, capacity: ids.length });
}

function answer(r: Booted, promoted: boolean): void {
  r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted } });
}

const jsonEnv = () => standbyEnv({ SMDB_RESHARD_DB: undefined, SMDB_RESHARD_COUNT: '3' });

describe("rf1: a JSON standby's ready message after 'shardReconnecting'", () => {
  it('a shard that reconnects is out until it is ready again, so two ready shards and a reconnecting one never send the ready message', async () => {
    const r = await boot({ env: jsonEnv() });
    await r.run;
    const client = r.ingest.getClient()!;
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardReconnecting', 1);
    emit(client, 'shardReady', 2, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([]);
    emit(client, 'shardReady', 1, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([{ type: 'reshard:standby-ready', data: { attempt: AT } }]);
  });
});

describe('rf1: the login budget loop while the process stops', () => {
  it('a stop begun while /gateway/bot is retried ends the budget wait: no second read, no throttler, no login, and the boot returns', async () => {
    const r = await boot({ gateway: async () => ({ info: null, error: 'HTTP 503' }) });
    await until(r, () => r.gatewayReads() === 1, 'the first /gateway/bot read');
    h.stopping = true;
    await tick(30_000);
    await tick(30_000);
    await until(r, () => r.settled() !== 'pending', 'the end of the standby boot');
    expect(r.failure()).toBeNull();
    expect(r.settled()).toBe('resolved');
    expect(r.gatewayReads()).toBe(1);
    expect(r.throttlers).toEqual([]);
    expect(r.logins).toEqual([]);
  });

  it('a self-stop begun while /gateway/bot is retried ends the budget wait: no second read and no login', async () => {
    const r = await boot({ gateway: async () => ({ info: null, error: 'HTTP 503' }) });
    await until(r, () => r.gatewayReads() === 1, 'the first /gateway/bot read');
    r.store.reshard = { ...r.store.reshard, state: 'cancelled' };
    r.store.attemptRow = { ...r.store.attemptRow, reason: 'B is not healthy' };
    await tick(1000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(1);
    await tick(29_000);
    await until(r, () => r.settled() !== 'pending', 'the end of the standby boot');
    expect(r.failure()).toBeNull();
    expect(r.gatewayReads()).toBe(1);
    expect(r.throttlers).toEqual([]);
    expect(r.logins).toEqual([]);
  });

  it("an answer with no session_start_limit and no error logs L31 with that cause", async () => {
    const r = await boot({ gateway: async () => ({ info: { recommendedShards: 8 }, error: null }) });
    await until(r, () => r.gatewayReads() === 1, 'the first /gateway/bot read');
    await until(r, () => r.lines.some(l => l.includes('gateway login limit')), 'the L31 line');
    expect(r.lines.filter(l => l.includes('gateway login limit'))).toEqual([
      "[Shards] Standby: cannot read Discord's gateway login limit (the answer has no session_start_limit); not connecting the new shards until it is read, trying again every 30 s",
    ]);
    expect(r.logins).toEqual([]);
  });
});

describe('rf1: the budget call-off', () => {
  it('a call-off that fails is logged with its cause, and the standby still asks the web UI before it stops', async () => {
    const store = standbyStore();
    readyElsewhere(store, [4, 5, 6, 7]);
    const r = await boot({ store, gateway: async () => gatewayAnswer(11, 600_000), callOffError: new Error('connection refused') });
    await until(r, () => r.settled() !== 'pending', 'the end of the standby boot');
    expect(r.lines).toContain('[Shards] Could not call the reshard off: connection refused');
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(1);
    expect(store.reshard.state).toBe('standby');
    expect(r.logins).toEqual([]);
  });

  it('the attempt it called off, read again by the 1 s poll, starts no second handshake, and the answer ends the asking', async () => {
    const store = standbyStore();
    readyElsewhere(store, [4, 5, 6, 7]);
    const r = await boot({ store, gateway: async () => gatewayAnswer(11, 600_000) });
    await until(r, () => r.settled() !== 'pending', 'the end of the standby boot');
    expect(store.reshard.state).toBe('cancelled');
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(1);
    await tick(1000);
    await tick(1000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(1);
    answer(r, false);
    await tick(1);
    const asked = r.channel.of('reshard:standby-stopping').length;
    await tick(20_000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(asked);
    expect(r.stops()).toBe(1);
  });
});

describe('rf1: the handshake ends its asking at the answer', () => {
  it("after the answer false no 'reshard:standby-stopping' is sent again", async () => {
    const r = await boot();
    await r.run;
    r.store.reshard = { ...r.store.reshard, state: 'cancelled' };
    r.store.attemptRow = { ...r.store.attemptRow, reason: 'B is not healthy' };
    await tick(1000);
    await tick(5000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(2);
    answer(r, false);
    await tick(1);
    expect(r.lines.at(-1)).toBe(l12Line(8, 'B is not healthy'));
    await tick(15_000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(2);
    expect(r.stops()).toBe(1);
  });
});

describe('rf1: the restart ask after a self-stop answered true', () => {
  it('the attempt called off: the restart reason names the reshard and its call-off reason', async () => {
    const r = await boot();
    await r.run;
    r.store.reshard = { ...r.store.reshard, state: 'cancelled' };
    r.store.attemptRow = { ...r.store.attemptRow, reason: 'B is not healthy' };
    await tick(1000);
    answer(r, true);
    await tick(1);
    const cause = 'the reshard to 8 shards was called off (B is not healthy)';
    expect(r.channel.of('control:restart-bot')).toEqual([{ type: 'control:restart-bot', data: { reason: cause } }]);
    expect(r.lines.at(-1)).toBe(l22PromotedLine(cause));
    expect(r.stops()).toBe(0);
  });

  it('the attempt replaced: the restart reason says the reshard has ended', async () => {
    const r = await boot();
    await r.run;
    r.store.reshard = { ...r.store.reshard, attempt: 'a1b2c3d4-0000-4000-8000-0000000000c5', toCount: 6 };
    await tick(1000);
    answer(r, true);
    await tick(1);
    const cause = 'the reshard to 8 shards has ended';
    expect(r.channel.of('control:restart-bot')).toEqual([{ type: 'control:restart-bot', data: { reason: cause } }]);
    expect(r.lines.at(-1)).toBe(l22PromotedLine(cause));
  });

  it("'maintenance:leave' twice asks for the restart once, and the 60 s resend runs once", async () => {
    const r = await boot();
    await r.run;
    r.channel.deliver({ type: 'maintenance:leave', requestId: 'm1' });
    r.channel.deliver({ type: 'maintenance:leave', requestId: 'm2' });
    expect(r.channel.answers('m2')).toEqual([{ requestId: 'm2', data: { leaving: true } }]);
    expect(r.channel.of('control:restart-bot')).toHaveLength(1);
    expect(r.lines.filter(l => l === l22PromotedLine('the bot left maintenance'))).toHaveLength(1);
    await tick(60_000);
    expect(r.channel.of('control:restart-bot')).toHaveLength(2);
  });
});

describe('rf1: the default stop handler', () => {
  it("with no stop handler given, the IPC channel's 'disconnect' begins the process stop", async () => {
    const r = await boot({ noStopDep: true });
    await r.run;
    expect(h.beginStops).toBe(0);
    r.channel.emit('disconnect');
    expect(h.beginStops).toBe(1);
  });
});
