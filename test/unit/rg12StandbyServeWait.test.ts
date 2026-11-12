import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunBotOptions } from '../../src/bot/internalSetup/fleet/standbyBoot';
import { RESHARD_SERVE_WAIT_MS } from '../../src/bot/internalSetup/fleet/shardBoot';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeChannel, gatewayAnswer, lineLog, markDone, standbyEnv, standbyStore } from '../helpers/standbyRig';

const h = vi.hoisted(() => ({ stopping: false }));

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
  writeShardRecord: () => undefined,
}));

const capacity = process.env.FLEET_SHARD_CAPACITY;
beforeEach(() => {
  h.stopping = false;
  process.env.FLEET_SHARD_CAPACITY = '8';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (capacity === undefined) delete process.env.FLEET_SHARD_CAPACITY;
  else process.env.FLEET_SHARD_CAPACITY = capacity;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function boot(o: { store?: MemClaimStore; remaining?: number } = {}) {
  vi.resetModules();
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const ingest = getIngestService();
  const store = o.store ?? standbyStore();
  ingest.start = (async () => '') as typeof ingest.start;
  ingest.close = async () => undefined;
  const work: string[] = [];
  const realWork = store.withWorkClient.bind(store);
  store.withWorkClient = ((what: string, fn: any) => { work.push(what); return realWork(what, fn); }) as typeof store.withWorkClient;
  const channel = new FakeChannel();
  const { lines, log } = lineLog();
  const runs: RunBotOptions[] = [];
  let stops = 0;
  await sb.standbyMain({
    env: standbyEnv(),
    storeFactory: () => store,
    channel,
    gateway: async () => { work.push('gateway'); return gatewayAnswer(o.remaining ?? 900); },
    takeLock: async () => undefined,
    runBot: async (opts: RunBotOptions) => { runs.push(opts); },
    stop: () => { stops += 1; },
    log,
  });
  return { store, channel, lines, runs, work, stops: () => stops };
}

/** Spies on the timer calls; the handle of the serve-wait timer once onDone armed it. */
function watchServeWaitTimer() {
  const set = vi.spyOn(globalThis, 'setTimeout');
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  const handle = () => {
    const at = set.mock.calls.findIndex(call => call[1] === RESHARD_SERVE_WAIT_MS);
    expect(at).toBeGreaterThanOrEqual(0);
    return set.mock.results[at].value;
  };
  return { clear, handle };
}

describe('rg12 the serve-wait timer of a done attempt', () => {
  it("rg12 a promotion after the attempt is done serves and clears the 300 s serve-wait timer", async () => {
    const r = await boot();
    const t = watchServeWaitTimer();
    markDone(r.store);
    await tick(1000);
    const timer = t.handle();
    expect(t.clear).not.toHaveBeenCalledWith(timer);
    r.channel.deliver({ type: 'reshard:promoted' });
    await tick(1);
    expect(r.runs).toHaveLength(1);
    expect(t.clear).toHaveBeenCalledWith(timer);
  });

  it('rg12 a call-off after the attempt is done stops the standby and clears the 300 s serve-wait timer', async () => {
    const r = await boot();
    const t = watchServeWaitTimer();
    markDone(r.store);
    await tick(1000);
    const timer = t.handle();
    r.store.reshard = { ...r.store.reshard, state: 'cancelled' };
    r.store.attemptRow = { ...r.store.attemptRow, reason: 'B is not healthy' };
    await tick(1000);
    expect(r.channel.of('reshard:standby-stopping')).toHaveLength(1);
    expect(t.clear).toHaveBeenCalledWith(timer);
    r.channel.deliver({ type: 'reshard:standby-stop-answer', data: { promoted: false } });
    await tick(1);
    expect(r.stops()).toBe(1);
    expect(r.runs).toEqual([]);
  });
});

describe('rg12 the login budget call-off', () => {
  it("rg12 too few gateway logins: the call-off runs on the work client under the label 'the call-off'", async () => {
    const r = await boot({ remaining: 0 });
    expect(r.work.slice(0, 3)).toEqual(['the login budget', 'gateway', 'the call-off']);
    expect(r.store.reshard.state).toBe('cancelled');
    expect(r.channel.of('reshard:standby-stopping')[0].data.kind).toBe('called-off');
  });
});
