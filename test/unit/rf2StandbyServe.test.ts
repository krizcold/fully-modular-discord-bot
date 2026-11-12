import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunBotOptions } from '../../src/bot/internalSetup/fleet/standbyBoot';
import type { StandbyTaken } from '../../src/bot/internalSetup/fleet/shardBoot';
import { l12Line, l22Line } from '../../src/bot/internalSetup/fleet/shardClaims';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeChannel, claimRow, T, gatewayAnswer, lineLog, markDone, standbyEnv, standbyStore } from '../helpers/standbyRig';

const h = vi.hoisted(() => ({
  stopping: false,
  records: [] as unknown[],
  recordError: null as Error | null,
  defaultRuns: [] as unknown[],
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
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: (record: unknown) => {
    if (h.recordError) throw h.recordError;
    h.records.push(record);
  },
}));
vi.mock('../../src/bot/internalSetup/clientInitializer', () => ({
  runBot: async (opts: unknown) => { h.defaultRuns.push(opts); },
}));

const capacity = process.env.FLEET_SHARD_CAPACITY;
beforeEach(() => {
  h.stopping = false;
  h.records.length = 0;
  h.recordError = null;
  h.defaultRuns.length = 0;
  process.env.FLEET_SHARD_CAPACITY = '8';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  if (capacity === undefined) delete process.env.FLEET_SHARD_CAPACITY;
  else process.env.FLEET_SHARD_CAPACITY = capacity;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

interface BootOpts {
  env?: Record<string, string | undefined>;
  store?: MemClaimStore;
  defaultRunBot?: boolean;
}

async function boot(o: BootOpts = {}) {
  vi.resetModules();
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const ingest = getIngestService();
  const store = o.store ?? standbyStore();
  ingest.start = (async () => '') as typeof ingest.start;
  const closes: string[] = [];
  ingest.close = async (reason: string) => { closes.push(reason); };
  const channel = new FakeChannel();
  const { lines, log } = lineLog();
  const runs: RunBotOptions[] = [];
  let stops = 0;
  await sb.standbyMain({
    env: o.env ?? standbyEnv(),
    storeFactory: () => store,
    channel,
    gateway: async () => gatewayAnswer(900),
    takeLock: async () => undefined,
    ...(o.defaultRunBot ? {} : { runBot: async (opts: RunBotOptions) => { runs.push(opts); } }),
    stop: () => { stops += 1; },
    log,
  });
  return { sb, ingest, store, channel, lines, runs, closes, stops: () => stops };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const jsonEnv = (over: Record<string, string | undefined> = {}) => standbyEnv({ SMDB_RESHARD_DB: undefined, SMDB_RESHARD_COUNT: '3', ...over });

async function done(r: Booted): Promise<void> {
  markDone(r.store);
  await tick(1000);
}

function promote(r: Booted): void {
  r.channel.deliver({ type: 'reshard:promoted' });
}

async function servedPostgres(store?: MemClaimStore): Promise<Booted> {
  const r = await boot({ store });
  await done(r);
  promote(r);
  await tick(1);
  expect(r.runs).toHaveLength(1);
  return r;
}

async function calledOff(r: Booted): Promise<void> {
  r.store.reshard = { ...r.store.reshard, state: 'cancelled' };
  r.store.attemptRow = { ...r.store.attemptRow, reason: 'B is not healthy' };
  await tick(1000);
  expect(r.channel.of('reshard:standby-stopping')).toHaveLength(1);
}

describe('rf2: the messages the standby ignores', () => {
  it('a null message is ignored without an error, and a later promotion still serves', async () => {
    const r = await boot({ env: jsonEnv() });
    expect(() => r.channel.emit('message', null)).not.toThrow();
    promote(r);
    await tick(1);
    expect(r.runs).toHaveLength(1);
  });

  it("a function carrying type 'reshard:promoted' is not a message: the standby does not serve", async () => {
    const r = await boot({ env: jsonEnv() });
    r.channel.emit('message', Object.assign(() => undefined, { type: 'reshard:promoted' }));
    await tick(1);
    expect(r.runs).toEqual([]);
  });

  it("'maintenance:enter' with a numeric requestId gets no answer", async () => {
    const r = await boot();
    r.channel.deliver({ type: 'maintenance:enter', requestId: 42 });
    r.channel.deliver({ type: 'maintenance:leave', requestId: 43 });
    expect(r.channel.sent.filter(m => m?.requestId !== undefined)).toEqual([]);
    expect(r.channel.of('control:restart-bot')).toEqual([]);
  });
});

describe("rf2: the handshake's answer", () => {
  it("an answer with no data counts as 'promoted: false': L12's line, then the stop", async () => {
    const r = await boot();
    await calledOff(r);
    expect(() => r.channel.deliver({ type: 'reshard:standby-stop-answer' })).not.toThrow();
    await tick(1);
    expect(r.lines.at(-1)).toBe(l12Line(8, 'B is not healthy'));
    expect(r.stops()).toBe(1);
  });
});

describe('rf2: the serve runs once', () => {
  it("a second 'reshard:promoted' after the serve does not run the bot again", async () => {
    const r = await boot({ env: jsonEnv() });
    promote(r);
    await tick(1);
    promote(r);
    await tick(1);
    expect(r.runs).toHaveLength(1);
  });

  it("a promotion while the process stops does not serve", async () => {
    const r = await boot({ env: jsonEnv() });
    h.stopping = true;
    promote(r);
    await tick(1);
    expect(r.runs).toEqual([]);
  });

  it("an IPC 'disconnect' after the serve does not run the stop handler", async () => {
    const r = await boot({ env: jsonEnv() });
    promote(r);
    await tick(1);
    r.channel.emit('disconnect');
    expect(r.stops()).toBe(0);
  });

  it('a lapse after the attempt is done ends the standby: a later promotion does not serve', async () => {
    const r = await boot();
    await done(r);
    r.store.renewMode = new Error('connection refused');
    await tick(T.deadlineMs + T.renewMs);
    const stopping = r.channel.of('reshard:standby-stopping');
    expect(stopping.length).toBeGreaterThan(0);
    expect(stopping[0].data.kind).toBe('failed');
    promote(r);
    await tick(1);
    expect(r.runs).toEqual([]);
    r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: false } });
    await tick(1);
    expect(r.lines.at(-1)).toBe(l22Line(stopping[0].data.reason));
    expect(r.stops()).toBe(1);
  });

  it('with no runBot given, the serve runs the clientInitializer runBot with the JSON taken', async () => {
    const r = await boot({ env: jsonEnv(), defaultRunBot: true });
    promote(r);
    await vi.waitFor(() => expect(h.defaultRuns).toHaveLength(1), { timeout: 500, interval: 5 });
    expect((h.defaultRuns[0] as RunBotOptions).taken).toMatchObject({ json: true, count: 3 });
    expect((h.defaultRuns[0] as RunBotOptions).client).toBe(r.ingest.getClient());
  });
});

describe("rf2: the JSON taken's from", () => {
  for (const from of ['0', '-2', '2.5', '']) {
    it(`SMDB_RESHARD_FROM=${JSON.stringify(from)} gives no from`, async () => {
      const r = await boot({ env: jsonEnv({ SMDB_RESHARD_FROM: from }) });
      promote(r);
      await tick(1);
      expect(r.runs).toHaveLength(1);
      expect('from' in (r.runs[0].taken as object)).toBe(false);
    });
  }
});

describe('rf2: what runBot gets to release', () => {
  function noRowStore(): MemClaimStore {
    const store = standbyStore();
    const B = { processId: 'p-b-standby', nodeId: 'n-b', nodeName: 'B' };
    for (let s = 0; s < 8; s++) store.rows.set(`8:${s}`, claimRow(8, s, B));
    store.nodes.set(B.nodeId, { ...store.nodes.get('n-a')!, nodeId: B.nodeId, nodeName: B.nodeName, processId: 'p-b-old' });
    return store;
  }

  it('with no Client (no row taken) releaseInjected and taken.release close no gateway', async () => {
    const r = await servedPostgres(noRowStore());
    expect(r.ingest.getClient()).toBeNull();
    await r.runs[0].releaseInjected!();
    await (r.runs[0].taken as StandbyTaken).release();
    expect(r.closes).toEqual([]);
  });

  it("taken.release after onServing closes the gateway but releases nothing on the pre-serve lanes", async () => {
    const r = await servedPostgres();
    (r.runs[0].taken as StandbyTaken).onServing!();
    await (r.runs[0].taken as StandbyTaken).release();
    expect(r.closes).toEqual(['shutting down']);
    expect(r.store.releases).toEqual([]);
    expect(r.sb.claimsPhase()).toBe('serving');
  });

  it('releaseInjected after onServing writes the shard record but releases nothing on the pre-serve lanes', async () => {
    const r = await servedPostgres();
    (r.runs[0].taken as StandbyTaken).onServing!();
    await r.runs[0].releaseInjected!();
    expect(h.records).toHaveLength(1);
    expect(r.store.releases).toEqual([]);
    expect(r.sb.claimsPhase()).toBe('serving');
  });

  it("a JSON standby's releaseInjected writes no shard record and leaves the phase 'serving'", async () => {
    const r = await boot({ env: jsonEnv() });
    promote(r);
    await tick(1);
    await r.runs[0].releaseInjected!();
    expect(r.closes).toEqual(['shutting down']);
    expect(h.records).toEqual([]);
    expect(r.sb.claimsPhase()).toBe('serving');
  });

  it('a shard record write that fails is logged with its cause, and the pre-serve release still runs', async () => {
    const r = await servedPostgres();
    h.recordError = new Error('EACCES: permission denied');
    const before = r.lines.length;
    await r.runs[0].releaseInjected!();
    expect(r.lines.slice(before)[0]).toBe('[Shards] Could not write the shard record: EACCES: permission denied');
    expect(r.store.releases).toHaveLength(1);
    expect(r.sb.claimsPhase()).toBe('released');
  });
});
