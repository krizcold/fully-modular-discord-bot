import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunBotOptions } from '../../src/bot/internalSetup/fleet/standbyBoot';
import type { StandbyTaken } from '../../src/bot/internalSetup/fleet/shardBoot';
import { FakeChannel, gatewayAnswer, lineLog, markDone, standbyEnv, standbyStore } from '../helpers/standbyRig';

// NB9 test 22 (42, C3): NB10's one stop handler, the real installStopHandler, with its steps recorded in order and
// process.exit and the signal listeners captured; and the claims stop by phase in a standby built by standbyMain() over
// the claims fake. The serve lanes' claims are a recorder.

const h = vi.hoisted(() => ({ order: [] as string[], exits: [] as Array<number | undefined> }));

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'n-a',
  getNodeName: () => 'A',
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({ ...(await orig<any>()), writeShardRecord: () => undefined }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', async orig => ({
  ...(await orig<any>()),
  getShardClaims: () => ({ finishStop: async () => { h.order.push('serve lanes released'); } }),
}));

let signals: Map<string, Array<() => unknown>>;
beforeEach(() => {
  vi.resetModules();
  h.order.length = 0;
  h.exits.length = 0;
  signals = new Map();
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => unknown) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      signals.set(event, [...(signals.get(event) ?? []), fn]);
      return process;
    }
    return realOn(event as any, fn);
  }) as typeof process.on);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { h.exits.push(code); }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env.FLEET_SHARD_CAPACITY = '8';
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FLEET_SHARD_CAPACITY;
});

async function sigterm(): Promise<void> {
  await Promise.all((signals.get('SIGTERM') ?? []).map(fn => fn()));
  for (let i = 0; i < 200 && h.exits.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

/** A standby with its rows taken and logged in (login stubbed), its stop handler the real one. */
async function standby() {
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const ingest = getIngestService();
  ingest.start = (async () => '') as typeof ingest.start;
  ingest.close = async () => { h.order.push('gateway closed'); };
  dm.installStopHandler();
  const store = standbyStore();
  const release = store.release.bind(store);
  store.release = (request, onSent, onConnected) => { h.order.push('pre-serve release'); return release(request, onSent, onConnected); };
  const channel = new FakeChannel();
  const { lines, log } = lineLog();
  const runs: RunBotOptions[] = [];
  await sb.standbyMain({ env: standbyEnv(), storeFactory: () => store, channel, log, gateway: async () => gatewayAnswer(900), takeLock: async () => undefined, runBot: async o => { runs.push(o); } });
  return { dm, sb, store, channel, lines, runs };
}

async function served() {
  const r = await standby();
  markDone(r.store);
  await new Promise(resolve => setTimeout(resolve, 1100));
  r.channel.deliver({ type: 'reshard:promoted' });
  for (let i = 0; i < 50 && r.runs.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return r;
}

describe("test 22: NB10's one stop handler (42, C3)", () => {
  it('runs the stop steps, the final steps, the drain, the steps after the drain, then the release steps, then exits 0; a step that throws does not stop it', async () => {
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dm.installStopHandler();
    dm.addStopStep(() => { h.order.push('stop step'); throw new Error('the samplers failed'); });
    dm.addStopStep(() => { h.order.push('second stop step'); });
    dm.addFinalStopStep(() => { h.order.push('final step'); });
    dm.addAfterDrainStep(() => { h.order.push(`after drain (draining ${dm.isExitDraining()})`); return false; });
    dm.addReleaseStep(async () => { h.order.push('release step'); throw new Error('the release failed'); });
    dm.addReleaseStep(async () => { h.order.push('second release step'); });
    await sigterm();
    expect(h.order).toEqual(['stop step', 'second stop step', 'final step', 'after drain (draining true)', 'release step', 'second release step']);
    expect(h.exits).toEqual([0]);
    expect(errors.mock.calls.map(c => String(c[0]))).toEqual(['[Data] A stop step failed:', '[Data] A stop step failed:']);
  });

  it("a standby stopped before it serves: the gateway closes, then one release, from the 'pre-serve' step, and exit 0", async () => {
    const r = await standby();
    await sigterm();
    expect(h.order).toEqual(['gateway closed', 'pre-serve release']);
    expect(r.store.releases).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });

  it("a stop after taken.onServing (the switch in bootShards({ taken })) releases through the 'serving' step only", async () => {
    const r = await served();
    (r.runs[0].taken as StandbyTaken).onServing!();
    await r.sb.claimsStop('pre-serve');
    await r.sb.claimsStop('serving');
    expect(h.order).toEqual(['serve lanes released']);
    expect(r.store.releases).toEqual([]);
  });

  it('after releaseInjected() a later stop releases nothing and logs no "no longer held" line', async () => {
    const r = await served();
    await r.runs[0].releaseInjected!();
    expect(h.order).toEqual(['gateway closed', 'pre-serve release']);
    h.order.length = 0;
    await sigterm();
    expect(h.order).toEqual(['gateway closed']);
    expect(r.store.releases).toHaveLength(1);
    expect(r.lines.filter(l => l.includes('no longer held'))).toEqual([]);
    expect(h.exits).toEqual([0]);
  });
});
