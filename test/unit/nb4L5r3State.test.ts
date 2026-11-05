import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setFleetStateSources, getFleetState } from '../../src/bot/internalSetup/fleet/state';
import type { NodeRow } from '../../src/bot/internalSetup/fleet/claimRules';
import type { PageRead } from '../../src/bot/internalSetup/fleet/claimStore';

// Decision 21's above-target list: the shards this process holds past its own node row's target, its node found by
// this boot's process id.

afterEach(() => {
  vi.useRealTimers();
});

function node(over: Partial<NodeRow>): NodeRow {
  return {
    nodeId: 'node-a', nodeName: 'A', processId: 'p-a', capacity: 4, takeoverSeconds: 30, fit: true, restartable: true,
    returns: true, seenAgoMs: 0, healthyForMs: 1000, ...over,
  };
}

function aboveTarget(processId: string, held: number[], nodes: NodeRow[]): number[] {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] });
  vi.advanceTimersByTime(100_000);
  const page: PageRead = { shardCount: 4, upMs: 100_000, uPrimeMs: 100_000, rows: [], nodes };
  const snap = {
    processId,
    held: held.map(shardId => ({ shardCount: 4, shardId, claim: 1 })),
    reserved: [],
    page,
    pageReadAt: performance.now(),
    renewalError: null,
    pageReadError: null,
    pendingRestart: null,
    restartWaiting: null,
    returning: [],
    stopped: null,
    renewMs: 5000,
  };
  _setFleetStateSources({
    nodeId: 'node-a', nodeName: 'A', appVersion: '1', shardSource: 'discord', recommendedShards: null, recommendedAt: null,
    runtime: { getCurrent: () => null, shardStatuses: () => [], getStillConnected: () => [] } as any,
    ingest: { getClient: () => null } as any,
    ledger: { getRecommendation: () => null, getBudgetInfo: () => null } as any,
    claims: { snapshot: () => snap } as any,
  });
  return getFleetState().aboveTarget;
}

describe('the above-target list', () => {
  it("uses this process's own node row, not the first row of the page", () => {
    const nodes = [
      node({ nodeId: 'node-x', nodeName: 'X', processId: 'p-x', capacity: 5 }),
      node({ nodeId: 'node-a', processId: 'p-a', capacity: 1 }),
    ];
    expect(aboveTarget('p-a', [2, 0, 1], nodes)).toEqual([1, 2]);
  });

  it('is empty while no node row has this process id', () => {
    const nodes = [node({ nodeId: 'node-x', nodeName: 'X', processId: 'p-x', capacity: 0 })];
    expect(aboveTarget('p-a', [2, 0, 1], nodes)).toEqual([]);
  });

  it("with no row of this process, falls back to the node row stored under the empty id", () => {
    const nodes = [
      node({ nodeId: 'node-x', nodeName: 'X', processId: 'p-x', capacity: 5 }),
      node({ nodeId: '', nodeName: 'Blank', processId: 'other', capacity: 0 }),
    ];
    expect(aboveTarget('p-me', [3], nodes)).toEqual([3]);
  });
});
