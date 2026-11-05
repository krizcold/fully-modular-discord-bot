import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSourceText } from '../helpers/sourceText';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { stopSteps } from '../helpers/stopRig';

// NB4 decision 16, sheet unit 7 (R2-T1 (5)): with no web UI process, a leave that ends before the boot take runs the
// stop handler: no take statement is sent, no renewal carries a pair, no login runs, no "Released shards" line is
// logged, and the process exits. The boot is the real bootShards with the real maintenance module and stop handler.

const h = vi.hoisted(() => ({
  plans: [] as Array<{ shards: number[]; shardCount: number }>,
  starts: 0,
  dataState: 'verifying' as string,
  exits: 0,
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => ({ info: { recommendedShards: 2, sessionStartLimit: null }, error: null })),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
  ...(await orig<any>()),
  getDataReadiness: () => ({ onLeaseChanged: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<any>()),
  cleanOrphanTmpFiles: vi.fn(async () => {}),
}));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'node-a', getNodeName: () => 'A', getAppVersion: () => '1.0.0',
}));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: (shards: number[], shardCount: number) => h.plans.push({ shards: [...shards], shardCount }),
    isStarted: () => false,
    start: vi.fn(async () => { h.starts += 1; return 'ok'; }),
    stop: vi.fn(async () => {}),
    getClient: () => null,
  };
  return { getIngestService: () => fake };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: h.dataState }),
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: () => undefined,
}));
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => 'postgres',
}));

let lines: string[] = [];
const realSend = process.send;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, { plans: [], starts: 0, dataState: 'verifying', exits: 0 });
  (process as { send?: unknown }).send = undefined;
  lines = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(process, 'exit').mockImplementation(((() => { h.exits += 1; }) as unknown) as typeof process.exit);
});
afterEach(() => {
  (process as { send?: unknown }).send = realSend;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function rig() {
  const store = new MemClaimStore(() => Date.now());
  const shardBoot = await import('../../src/bot/internalSetup/fleet/shardBoot');
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  const m = await import('../../src/bot/internalSetup/utils/maintenance');
  const gate = await import('../../src/bot/internalSetup/utils/maintenanceGate');
  m._setMaintenanceTiming({ leaveRetryMs: 1000, filePollMs: 1000, leaveSaveBoundMs: 2000 });
  shardBoot._setClaimStoreFactory(() => store);
  dm.stopHandler(stopSteps({ claims: () => shardBoot.getShardClaims(), drainForExit: dm.drainForExit, hasWorkingSet: () => false }));
  return { store, shardBoot, m, gate };
}

function expectNothingTaken(store: MemClaimStore) {
  expect(store.takes).toEqual([]);
  expect(store.renewals.every(q => q.pairs.length === 0)).toBe(true);
  expect(store.releases).toEqual([]);
  expect([...store.rows.values()]).toEqual([]);
  expect(h.starts).toBe(0);
  expect(h.plans.every(p => p.shards.length === 0)).toBe(true);
  expect(lines.some(l => l.startsWith('[Shards] Released shards'))).toBe(false);
}

describe('a leave that ends before the boot take, with no web UI process', () => {
  it('a 28000 from the watcher while the boot waits for serving: the stop runs and the process exits; when the database serves, nothing is taken or logged in', async () => {
    const r = await rig();
    void r.shardBoot.bootShards();
    let fire: () => void = () => undefined;
    r.m.watchDataBackend({ onLoginRefused: cb => { fire = cb; }, askDatabase: async () => 'refused' }, { retryMs: 600_000 });
    await vi.advanceTimersByTimeAsync(2000);
    fire();
    expect(r.gate.isMaintenanceGateClosed()).toBe(true);
    expect(lines).toContain('[Maintenance] The database refused the login (SQLSTATE 28000) while the bot process booted; saving what this process holds before it stops (no web UI process runs to restart it)');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.exits).toBe(1);
    h.dataState = 'serving';
    await vi.advanceTimersByTimeAsync(60_000);
    expectNothingTaken(r.store);
    expect(h.exits).toBe(1);
  });

  it('maintenance.json turning to maintenance after decideBoot and back to running before the take: the same', async () => {
    const r = await rig();
    const mf = await import('../../src/utils/maintenanceFile');
    try {
      mf.writeMaintenanceFile('maintenance', 'm');
      r.m.setupMaintenanceIPCAtBoot();
      expect(r.gate.maintenanceCause()).toBe('hook');
      void r.shardBoot.bootShards();
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.exits).toBe(0);
      mf.writeMaintenanceFile('running', 'm');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lines).toContain('[Maintenance] maintenance.json says running; saving what this process holds before it stops (no web UI process runs to restart it)');
      expect(h.exits).toBe(1);
      h.dataState = 'serving';
      await vi.advanceTimersByTimeAsync(60_000);
      expectNothingTaken(r.store);
      expect(h.exits).toBe(1);
    } finally {
      fs.rmSync(mf.maintenanceFilePath(), { force: true });
    }
  });
});

describe("where main() builds the normal boot's stop handler (NB4-R9-T2)", () => {
  it('after decideBoot answers, and before the maintenance listener, the data watcher and the boot take, with both signals on it', () => {
    const source = readSourceText(__dirname, '../../src/bot/internalSetup/clientInitializer.ts');
    const main = source.slice(source.indexOf('async function main()'));
    const order = [
      'await decideBoot()',
      'const shutdownHandler = stopHandler(',
      "process.on('SIGTERM', () => void shutdownHandler())",
      "process.on('SIGINT', () => void shutdownHandler())",
      'setupMaintenanceIPCAtBoot()',
      'watchDataBackend(',
      'await bootShards()',
    ].map(text => main.indexOf(text));
    expect(order.every(i => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});
