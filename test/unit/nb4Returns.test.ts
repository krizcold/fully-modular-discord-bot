import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, planReturns, type ClaimRow, type NodeRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';
import { stopSteps } from '../helpers/stopRig';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { saveData } from '../../src/bot/internalSetup/utils/dataManager';

// NB4 decision 11 (R2-RETURNS): which held shard goes back to its home at the next stop, and which moves to a node
// with room when this process is above its target. A receiver is fit, has a web UI, has been healthy for 300 s, was
// seen within its takeover delay, and has room. FLEET_SHARD_RETURN=false decides none.

const T = claimTimings(30);
const A = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackendKind(null);
});

function row(shardId: number, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount: 4, shardId, claim: 10 + shardId, holderProcess: 'p-a', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 1_000_000, extended: false, ...over,
  };
}
function node(nodeId: string, over: Partial<NodeRow> = {}): NodeRow {
  return {
    nodeId, nodeName: nodeId.slice(-1).toUpperCase(), processId: `p-${nodeId}`, capacity: 1, takeoverSeconds: 30, fit: true,
    restartable: true, returns: true, seenAgoMs: 0, healthyForMs: 300_000, ...over,
  };
}
const pair = (r: ClaimRow): Pair => ({ shardCount: r.shardCount, shardId: r.shardId, claim: r.claim });

describe('planReturns', () => {
  const rows = [row(0), row(2, { homeNode: 'node-b' })];
  const plan = (nodes: NodeRow[], capacity = 2, rs = rows) => planReturns({ me: A, capacity, held: rs.map(pair), rows: rs, nodes, upMs: 0 });

  it('a held row homed at a fit B with room, healthy for 300 s, goes back to B and is not a move', () => {
    expect(plan([node('node-b')])).toEqual([{ shardId: 2, receiver: 'node-b', move: false }]);
  });

  it.each([
    ['healthy for 299 s', { healthyForMs: 299_999 }],
    ['not fit', { fit: false, healthyForMs: null }],
    ['with no web UI', { restartable: false }],
    ['not seen within its takeover delay', { seenAgoMs: 30_000 }],
    ['at its target', { capacity: 0 }],
  ])('B %s receives nothing', (_name, over) => {
    expect(plan([node('node-b', over)])).toEqual([]);
  });

  it('B counts its own live rows against its room', () => {
    const full = [...rows, row(3, { holderProcess: 'p-node-b', holderNode: 'node-b', homeNode: 'node-b' })];
    expect(planReturns({ me: A, capacity: 2, held: rows.map(pair), rows: full, nodes: [node('node-b')], upMs: 0 })).toEqual([]);
  });

  it('above its target, A moves exactly its excess to a node with room, rows homed elsewhere first', () => {
    const held = [row(0), row(1, { homeNode: 'node-x' }), row(2)];
    expect(planReturns({ me: A, capacity: 1, held: held.map(pair), rows: held, nodes: [node('node-c')], upMs: 0 }))
      .toEqual([{ shardId: 1, receiver: 'node-c', move: true }]);
    expect(planReturns({ me: A, capacity: 1, held: held.map(pair), rows: held, nodes: [node('node-c', { capacity: 5 })], upMs: 0 }))
      .toHaveLength(2);
    expect(planReturns({ me: A, capacity: 2, held: held.slice(0, 2).map(pair), rows: held.slice(0, 2), nodes: [node('node-c', { capacity: 5 })], upMs: 0 }))
      .toEqual([]);
  });

  it('never moves a shard to a node with no web UI, and does not return one homed there', () => {
    const held = [row(0), row(1, { homeNode: 'node-b' }), row(2)];
    expect(planReturns({ me: A, capacity: 1, held: held.map(pair), rows: held, nodes: [node('node-b', { restartable: false, capacity: 4 })], upMs: 0 }))
      .toEqual([]);
  });
});

describe('the work cycle with FLEET_SHARD_RETURN on and off', () => {
  async function rig(returns: boolean) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    const restarts: string[] = [];
    const lines: string[] = [];
    const claims = new ShardClaims({
      store, me: A, timings: T, capacity: 2, takeoverSeconds: 30, returns, restartable: true, startedAt: 0,
      fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
      noteLapsed: () => undefined, noteLost: () => undefined,
      restartForShards: reason => { restarts.push(reason); return true; },
      log: { log: l => lines.push(String(l)), warn: l => lines.push(String(l)), error: l => lines.push(String(l)) },
    });
    claims.start();
    await claims.firstRenewal();
    const taken = await claims.bootTake(async () => 2);
    claims.noteGranted();
    expect(taken!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    store.rows.get('2:1')!.homeNode = 'node-b';
    store.nodes.set('node-b', {
      nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
      seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now() - 301_000,
    });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    return { store, claims, restarts, lines };
  }

  it('on: the cycle decides the return to B, asks the restart, and the release hands exactly that shard', async () => {
    const r = await rig(true);
    expect(r.claims.snapshot().returning).toEqual([1]);
    expect(r.restarts).toEqual(['return shard 1 to B']);
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases.at(-1)!.handOvers).toEqual([{ shardId: 1, receiver: 'node-b', move: false }]);
    expect(r.store.rows.get('2:1')).toMatchObject({ holderNode: 'node-b', released: true });
    expect(r.store.rows.get('2:0')).toMatchObject({ holderNode: 'node-a', released: true });
    expect(r.lines).toContain('[Shards] Handed shard 1 to B');
  });

  it('on, with a write the drain could not save: the release still hands shard 1 to B after the drain (decision 11: no unsaved-write condition)', async () => {
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const r = await rig(true);
    expect(r.claims.snapshot().returning).toEqual([1]);
    setBackendKind('postgres');
    const data = new FakeStore();
    const ws = initWorkingSet(data);
    const guildId = String(5n << 22n);
    expect(await ws.hydrate(guildId, tokenFor())).toBe('ready');
    data.mode = 'unavailable';
    saveData('g.json', { guildId, category: 'm' }, { v: 1 });
    const order: string[] = [];
    const stop = stopSteps(dm, { claims: () => r.claims, order });
    const stopped = stop();
    await vi.advanceTimersByTimeAsync(40_000);
    await stopped;
    expect(order).toEqual(['beginStop', 'drain', 'finishStop', 'exit']);
    expect(warns).toContain(`[Data] Shutdown drain left 1 guild(s) with unflushed writes: ${guildId}`);
    expect(ws.dirtyGuildIds()).toEqual([guildId]);
    expect(data.doc(guildId, 'g.json')).toBeUndefined();
    expect(r.store.releases).toHaveLength(1);
    expect(r.store.releases[0].handOvers).toEqual([{ shardId: 1, receiver: 'node-b', move: false }]);
    expect(r.store.rows.get('2:1')).toMatchObject({ holderNode: 'node-b', released: true });
    expect(r.lines).toContain('[Shards] Handed shard 1 to B');
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it('off: no return is decided, no restart is asked, and the release hands nothing', async () => {
    const r = await rig(false);
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    expect(r.claims.snapshot().returning).toEqual([]);
    expect(r.restarts).toEqual([]);
    r.claims.beginStop();
    await r.claims.finishStop();
    expect(r.store.releases.at(-1)!.handOvers).toEqual([]);
    expect(r.store.rows.get('2:1')).toMatchObject({ holderNode: 'node-a', released: true });
    expect(r.lines.some(l => l.startsWith('[Shards] Handed'))).toBe(false);
  });
});
