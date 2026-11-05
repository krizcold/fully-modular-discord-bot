import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB4 decision 10 (b): this node's row names the process that wrote its last heartbeat. The first heartbeat of a new
// process replaces its predecessor's silently; two live processes with one node id (a copied node.json) overwrite each
// other's row at every tick, and each logs the copied-id line at most once in 10 minutes.

const T = claimTimings(30);
const LINE = "[Shards] Another bot process with this machine's id (node-a) writes this machine's row; a copied /data/global/fleet/node.json gives two machines one id";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function botProcess(store: MemClaimStore, processId: string) {
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const claims = new ShardClaims({
    store, me: { processId, nodeId: 'node-a', nodeName: 'A' }, timings: T, capacity: 1, takeoverSeconds: 30, returns: true,
    restartable: true, startedAt: 0, fitness: () => null, gateClosed: () => false, isStopping: () => false,
    stopServingStep: () => undefined, noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => false, log,
  });
  const copies = () => log.error.mock.calls.map(c => String(c[0])).filter(l => l === LINE).length;
  return { claims, copies };
}

describe('the heartbeat of this node', () => {
  it('a first heartbeat replacing the previous process\'s row logs nothing, and nor do its later ones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    const old = botProcess(store, 'p-old');
    await old.claims.renewOnce();
    const next = botProcess(store, 'p-new');
    await next.claims.renewOnce();
    expect(store.nodes.get('node-a')!.processId).toBe('p-new');
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(T.renewMs);
      await next.claims.renewOnce();
    }
    expect(next.copies()).toBe(0);
  });

  it('two processes alternating on one row log the copied-id line once in 10 minutes each', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    const t0 = Date.now();
    const a = botProcess(store, 'p-a');
    const b = botProcess(store, 'p-b');
    await a.claims.renewOnce();
    await b.claims.renewOnce();
    const tick = async () => {
      await vi.advanceTimersByTimeAsync(T.renewMs);
      await a.claims.renewOnce();
      await b.claims.renewOnce();
    };
    await tick();
    expect(a.copies()).toBe(1);
    expect(b.copies()).toBe(1);
    while (Date.now() - t0 < 10 * 60_000 - T.renewMs) await tick();
    expect(a.copies()).toBe(1);
    expect(b.copies()).toBe(1);
    for (let i = 0; i < 3; i++) await tick();
    expect(a.copies()).toBe(2);
    expect(b.copies()).toBe(2);
  });
});
