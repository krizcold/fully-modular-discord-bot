import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setFleetStateSources, getFleetState, setReshardSource } from '../../src/bot/internalSetup/fleet/state';
import type { PageAttempt, PageRead } from '../../src/bot/internalSetup/fleet/claimStore';
import type { GateRead } from '../../src/bot/internalSetup/fleet/reshardRules';

// NB9 21: the fleet page's reshard fields, from the last page read (Postgres) or the driver's own memory (JSON).

afterEach(() => {
  setReshardSource(null);
  vi.useRealTimers();
});

const AGE_MS = 3000;

function gate(over: Partial<GateRead>): GateRead {
  return { attempt: 'att-1', state: 'standby', fromCount: 2, toCount: 4, metaCount: 2, ...over };
}

function attempt(over: Partial<PageAttempt>): PageAttempt {
  return {
    method: 'overlap', reason: 'wanted 4', startedAgoMs: 1000, untilMs: 10_000, endedAgoMs: 2000, connected: 3,
    waitingFor: ['B'], ...over,
  };
}

function show(opts: { page: PageRead | null; claims?: boolean }) {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] });
  vi.advanceTimersByTime(100_000);
  const now = performance.now();
  const snap = {
    processId: 'p-a', held: [], reserved: [], page: opts.page, pageReadAt: opts.page ? now - AGE_MS : null,
    renewalError: null, pageReadError: null, pendingRestart: null, restartWaiting: null, returning: [], stopped: null,
    renewMs: 5000,
  };
  _setFleetStateSources({
    nodeId: 'node-a', nodeName: 'A', appVersion: '1', shardSource: 'discord', recommendedShards: null, recommendedAt: null,
    runtime: { getCurrent: () => null, shardStatuses: () => [], getStillConnected: () => [] } as any,
    ingest: { getClient: () => null } as any,
    ledger: { getRecommendation: () => null, getBudgetInfo: () => null } as any,
    claims: opts.claims === false ? null : ({ snapshot: () => snap } as any),
  });
  return getFleetState();
}

function page(reshard: GateRead, more?: PageAttempt): PageRead {
  return { shardCount: 2, upMs: 100_000, uPrimeMs: 100_000, rows: [], nodes: [], reshard, ...(more ? { attempt: more } : {}) };
}

describe('the open attempt', () => {
  for (const state of ['standby', 'flipped', 'stopping'] as const) {
    it(`shows an attempt in ${state} as open, its times moved on by the read age, and no last reshard`, () => {
      const out = show({ page: page(gate({ state }), attempt({})) });
      expect(out.reshard).toEqual({
        attempt: 'att-1', from: 2, to: 4, method: 'overlap', state, startedAgoMs: 1000 + AGE_MS, untilMs: 10_000 - AGE_MS,
        reason: 'wanted 4', connected: 3, waitingFor: ['B'],
      });
      expect(out.lastReshard).toBeNull();
    });
  }

  it('shows the time left as zero once the read age passes it', () => {
    const out = show({ page: page(gate({}), attempt({ untilMs: 1000 })) });
    expect(out.reshard!.untilMs).toBe(0);
  });

  it('shows no machines waited for when the page has no attempt details', () => {
    const out = show({ page: page(gate({})) });
    expect(out.reshard).toMatchObject({ method: null, startedAgoMs: null, untilMs: null, reason: null, connected: 0, waitingFor: [] });
  });

  for (const missing of ['attempt', 'fromCount', 'toCount'] as const) {
    for (const state of ['standby', 'done'] as const) {
      it(`shows neither an open nor an ended attempt in ${state} when the row has no ${missing}`, () => {
        const out = show({ page: page(gate({ state, [missing]: null }), attempt({})) });
        expect(out.reshard).toBeNull();
        expect(out.lastReshard).toBeNull();
      });
    }
  }
});

describe('the last reshard', () => {
  for (const state of ['done', 'cancelled'] as const) {
    it(`shows an attempt in ${state} as ended at its database time less the read age, and none open`, () => {
      const out = show({ page: page(gate({ state }), attempt({})) });
      expect(out.lastReshard).toEqual({
        from: 2, to: 4, method: 'overlap', state, endedAt: Date.now() - 2000 - AGE_MS, reason: 'wanted 4',
      });
      expect(out.reshard).toBeNull();
    });
  }

  it('shows no reshard at all for a row with no state', () => {
    const out = show({ page: page(gate({ state: null }), attempt({})) });
    expect(out.reshard).toBeNull();
    expect(out.lastReshard).toBeNull();
  });
});

describe('the reshard source', () => {
  const own = {
    reshard: null,
    reshardWait: { wanted: 4, source: 'setting' as const, reason: 'one machine' },
    lastReshard: { from: 1, to: 2, method: 'stop-start' as const, state: 'done' as const, endedAt: 5, reason: null },
    target: { count: 2, by: 'A', at: 7 },
  };

  it('fills all four fields of a JSON bot from the driver', () => {
    setReshardSource(() => own);
    const out = show({ page: null, claims: false });
    expect(out.reshardWait).toEqual(own.reshardWait);
    expect(out.lastReshard).toEqual(own.lastReshard);
    expect(out.target).toEqual(own.target);
  });

  it('adds only the wait to a Postgres bot page read', () => {
    setReshardSource(() => own);
    const out = show({ page: page(gate({}), attempt({})) });
    expect(out.reshardWait).toEqual(own.reshardWait);
    expect(out.reshard).not.toBeNull();
    expect(out.lastReshard).toBeNull();
  });
});
