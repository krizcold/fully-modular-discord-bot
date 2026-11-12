import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Partials, type Client } from 'discord.js';

import { AT, FakeChannel, T, gatewayAnswer, lineLog, standbyEnv, standbyStore } from '../helpers/standbyRig';

const h = vi.hoisted(() => ({
  stopSteps: [] as Array<() => Promise<void>>,
  stopping: false,
}));

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'n-a',
  getNodeName: () => 'A',
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: (step: () => Promise<void>) => { h.stopSteps.push(step); },
  addReleaseStep: () => undefined,
  isStopping: () => h.stopping,
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: () => undefined,
}));

const capacity = process.env.FLEET_SHARD_CAPACITY;
beforeEach(() => {
  h.stopSteps.length = 0;
  h.stopping = false;
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
  store?: ReturnType<typeof standbyStore>;
}

async function boot(o: BootOpts = {}) {
  vi.resetModules();
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const ingest = getIngestService();
  const store = o.store ?? standbyStore();
  const logins: Array<string | undefined> = [];
  ingest.start = (async (token: string | undefined) => { logins.push(token); return ''; }) as typeof ingest.start;
  const throttlers: unknown[] = [];
  const setThrottler = ingest.setIdentifyThrottler.bind(ingest);
  ingest.setIdentifyThrottler = build => { throttlers.push(build); setThrottler(build); };
  const closes: string[] = [];
  let closeError: Error | null = null;
  ingest.close = async (reason: string) => { closes.push(reason); if (closeError) throw closeError; };
  const channel = new FakeChannel();
  const { lines, log } = lineLog();
  let stops = 0;
  await sb.standbyMain({
    env: o.env ?? standbyEnv(),
    storeFactory: () => store,
    channel,
    gateway: async () => gatewayAnswer(900),
    takeLock: async () => undefined,
    runBot: async () => undefined,
    stop: () => { stops += 1; },
    log,
  });
  return {
    sb, ingest, store, channel, lines, logins, throttlers, closes, stops: () => stops,
    failClose: (error: Error) => { closeError = error; },
  };
}

const jsonEnv = (over: Record<string, string | undefined> = {}) => standbyEnv({ SMDB_RESHARD_DB: undefined, SMDB_RESHARD_COUNT: '3', ...over });

describe("re4: a JSON standby's 'reshard:standby-ready' follows each shard's state", () => {
  it("'shardResume' counts a shard as connected: two ready and one resumed sends the ready message once", async () => {
    const r = await boot({ env: jsonEnv() });
    const client = r.ingest.getClient()!;
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardReady', 1, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([]);
    emit(client, 'shardResume', 2, 0);
    expect(r.channel.of('reshard:standby-ready')).toEqual([{ type: 'reshard:standby-ready', data: { attempt: AT } }]);
  });

  it("'shardDisconnect' takes a shard out: it is not ready again until it reconnects", async () => {
    const r = await boot({ env: jsonEnv() });
    const client = r.ingest.getClient()!;
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardReady', 1, new Set());
    emit(client, 'shardDisconnect', { code: 1006 }, 1);
    emit(client, 'shardReady', 2, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([]);
    emit(client, 'shardResume', 1, 0);
    expect(r.channel.of('reshard:standby-ready')).toEqual([{ type: 'reshard:standby-ready', data: { attempt: AT } }]);
  });

  it("'shardReconnecting' takes a shard out: it is not ready again until it reconnects", async () => {
    const r = await boot({ env: jsonEnv() });
    const client = r.ingest.getClient()!;
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardReady', 1, new Set());
    emit(client, 'shardReconnecting', 1);
    emit(client, 'shardReady', 2, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([]);
    emit(client, 'shardReady', 1, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([{ type: 'reshard:standby-ready', data: { attempt: AT } }]);
  });

  it('a shard that disconnects before it was ever ready does not count as connected', async () => {
    const r = await boot({ env: jsonEnv() });
    const client = r.ingest.getClient()!;
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardReady', 1, new Set());
    emit(client, 'shardDisconnect', { code: 1006 }, 2);
    expect(r.channel.of('reshard:standby-ready')).toEqual([]);
  });

  it('the ready message goes once, however often the shards flap after it', async () => {
    const r = await boot({ env: jsonEnv() });
    const client = r.ingest.getClient()!;
    for (let s = 0; s < 3; s++) emit(client, 'shardReady', s, new Set());
    emit(client, 'shardReady', 0, new Set());
    emit(client, 'shardDisconnect', { code: 1006 }, 1);
    emit(client, 'shardResume', 1, 0);
    expect(r.channel.of('reshard:standby-ready')).toHaveLength(1);
  });

  it('with no SMDB_RESHARD_STANDBY the ready message names an empty attempt', async () => {
    const r = await boot({ env: jsonEnv({ SMDB_RESHARD_STANDBY: undefined }) });
    const client = r.ingest.getClient()!;
    for (let s = 0; s < 3; s++) emit(client, 'shardReady', s, new Set());
    expect(r.channel.of('reshard:standby-ready')).toEqual([{ type: 'reshard:standby-ready', data: { attempt: '' } }]);
  });

  it('the Client is built with the message, reaction and user partials', async () => {
    const r = await boot({ env: jsonEnv() });
    expect(r.ingest.getClient()!.options.partials).toEqual([Partials.Message, Partials.Reaction, Partials.User]);
  });
});

describe('re4: a standby started while the process stops', () => {
  it('builds no Client and logs nothing in', async () => {
    h.stopping = true;
    const r = await boot({ env: jsonEnv() });
    expect(r.ingest.getClient()).toBeNull();
    expect(r.logins).toEqual([]);
  });

  it('its gateway stop step closes nothing when no Client was built', async () => {
    h.stopping = true;
    const r = await boot({ env: jsonEnv() });
    expect(h.stopSteps).toHaveLength(1);
    await h.stopSteps[0]();
    expect(r.closes).toEqual([]);
  });
});

describe("re4: the standby's gateway stop step", () => {
  it("closes the gateway with the reason 'shutting down'", async () => {
    const r = await boot({ env: jsonEnv() });
    await h.stopSteps[0]();
    expect(r.closes).toEqual(['shutting down']);
    expect(r.lines).toEqual([]);
  });

  it('a close that fails is logged with its cause and does not fail the step', async () => {
    const r = await boot({ env: jsonEnv() });
    r.failClose(new Error('the websocket is gone'));
    await expect(h.stopSteps[0]()).resolves.toBeUndefined();
    expect(r.lines).toEqual(['[Shards] Could not close the gateway on shutdown: the websocket is gone']);
  });
});

describe('re4: the pre-serve claims lanes', () => {
  it('a store with no identify slot statement gives the Client a local throttler that grants without the database', async () => {
    const r = await boot();
    expect(r.throttlers).toHaveLength(1);
    const throttler = await (r.throttlers[0] as (m: object) => Promise<any>)({ fetchGatewayInformation: async () => ({ session_start_limit: { max_concurrency: 1 } }) });
    expect(throttler.mode()).toBe('local');
    let outcome = 'waiting';
    throttler.waitForIdentify(0, new AbortController().signal).then(() => { outcome = 'granted'; }, (e: unknown) => { outcome = `failed: ${String(e)}`; });
    await tick(T.renewMs);
    expect(outcome).toBe('granted');
  });

  it("renewals refused by the database login past the deadline end the standby: the handshake of kind 'failed'", async () => {
    const r = await boot();
    r.store.renewMode = Object.assign(new Error('password authentication failed for user "claims"'), { code: '28000' });
    await tick(T.deadlineMs + T.renewMs);
    const stopping = r.channel.of('reshard:standby-stopping');
    expect(stopping.length).toBeGreaterThan(0);
    expect(stopping[0].data.kind).toBe('failed');
    expect(stopping[0].data.reason).toMatch(/^no claim renewal for \d+ s$/);
  });
});

describe('re4: _resetStandbyBoot', () => {
  it("puts the claims phase back to 'serving' and the maintenance answers back on", async () => {
    const r = await boot();
    expect(r.sb.claimsPhase()).toBe('pre-serve');
    r.sb.endStandbyMaintenanceAnswers();
    r.sb._resetStandbyBoot();
    expect(r.sb.claimsPhase()).toBe('serving');
    r.channel.deliver({ type: 'maintenance:enter', requestId: 'm1' });
    expect(r.channel.answers('m1')).toEqual([{ requestId: 'm1', data: { saved: true } }]);
  });
});
