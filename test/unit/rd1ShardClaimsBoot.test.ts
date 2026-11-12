import { describe, expect, it } from 'vitest';

import { ShardClaims, l13Line, l14Line, l16Line, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { ClaimTimings, Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import {
  ClaimPausedError,
  type ClaimStoreApi,
  type HeldRow,
  type PageRead,
  type PageRow,
  type RedrawAnswer,
  type RenewAnswer,
  type RenewRequest,
  type TakeAnswer,
  type TakeRequest,
} from '../../src/bot/internalSetup/fleet/claimStore';
import type { GateRead } from '../../src/bot/internalSetup/fleet/reshardRules';

// NB4 and NB9 over a scripted claims store: the boot's page read and branch (74), the held and count answers of the
// boot take (56, 77), L13, L14 and L17, the first renewal after a database stop (NB5 E2), the standby's renewal (C14)
// and the redraw's refusals (29).

const ME = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };
const T: ClaimTimings = { ttlMs: 30_000, renewMs: 2, deadlineMs: 60_000, statementMs: 1500, lockMs: 750 };

function gate(over: Partial<GateRead> = {}): GateRead {
  return { attempt: null, state: null, fromCount: null, toCount: null, metaCount: 4, target: null, targetBy: null, targetAt: null, ...over };
}

function row(count: number, shardId: number, over: Partial<PageRow> = {}): PageRow {
  return {
    shardCount: count, shardId, claim: 1, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B',
    homeNode: 'node-b', released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000,
    expiresUpMs: 5000, extended: false, renewedAgoMs: 0, ...over,
  };
}

function page(reshard: GateRead | undefined, rows: PageRow[] = []): PageRead {
  return { shardCount: reshard?.metaCount ?? null, upMs: 1000, uPrimeMs: 1000, rows, nodes: [], ...(reshard ? { reshard } : {}) };
}

function done(count: number, ids: number[], read?: GateRead): TakeAnswer {
  return {
    kind: 'done', shardCount: count, taken: ids.map(id => ({ pair: { shardCount: count, shardId: id, claim: 1 }, above: null })),
    plan: { takes: [], wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: 0 } as never,
    predecessorRenewedAt: new Map(), ...(read ? { read } : {}),
  };
}

const held = (count: number, shardId: number, holderName = 'B'): HeldRow => ({ shardCount: count, shardId, holderName });

interface RigOpts {
  page?: PageRead | Error;
  takes?: TakeAnswer[];
  onTake?: (req: TakeRequest, claims: ShardClaims) => void;
  setting?: number | null;
  stopping?: boolean;
  renew?: (req: RenewRequest, claims: ShardClaims, opts?: { move?: boolean }) => Promise<RenewAnswer>;
  renewStandby?: boolean | (() => Promise<RenewAnswer>);
  standby?: boolean;
  redraw?: () => Promise<RedrawAnswer>;
}

function rig(o: RigOpts = {}) {
  const lines: string[] = [];
  const fmt = (a: unknown[]) => a.map(x => (x instanceof Error ? x.message : String(x))).join(' ');
  const log = {
    log: (...a: unknown[]) => { lines.push(fmt(a)); },
    warn: (...a: unknown[]) => { lines.push(fmt(a)); },
    error: (...a: unknown[]) => { lines.push(fmt(a)); },
  };
  const calls = { pages: 0, takes: [] as TakeRequest[], renews: [] as Array<{ req: RenewRequest; move: boolean }>, redraws: 0, stopStep: 0 };
  const takes = [...(o.takes ?? [])];
  const plainAnswer = (req: RenewRequest): RenewAnswer => ({
    rows: req.pairs.map(p => ({ ...p, mine: true, released: false })), at: 1_000_000, priorProcess: ME.processId,
  });
  let claims: ShardClaims;
  const store: ClaimStoreApi = {
    async renew(req, opts) {
      calls.renews.push({ req, move: opts?.move === true });
      if (o.renew) return o.renew(req, claims, opts);
      return plainAnswer(req);
    },
    ...(o.renewStandby
      ? { renewStandby: typeof o.renewStandby === 'function' ? o.renewStandby : async () => ({ rows: [], at: 1_000_000, priorProcess: null }) }
      : {}),
    async take(req, onBegin) {
      calls.takes.push(req);
      onBegin?.();
      o.onTake?.(req, claims);
      const next = takes.shift();
      if (!next) throw new Error('the script has no more take answers');
      return next;
    },
    ...(o.redraw ? { redraw: async (_req: unknown, onBegin?: () => void) => { calls.redraws += 1; onBegin?.(); return o.redraw!(); } } : {}),
    pause() { /* the gate is not modelled */ },
    resume() { /* the gate is not modelled */ },
    async retake() { throw new Error('no re-take in these tests'); },
    async release() { return []; },
    async readPage() {
      calls.pages += 1;
      const p = o.page ?? new Error('no page');
      if (p instanceof Error) throw p;
      return p;
    },
    async readRow() { return { row: null, storedCount: null }; },
    abandonWork() { /* nothing on the wire */ },
    abandonRenewal() { /* nothing on the wire */ },
    async end() { /* nothing to end */ },
  };
  const deps: ShardClaimsDeps = {
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => o.stopping === true,
    stopServingStep: () => { calls.stopStep += 1; }, noteLapsed: () => undefined, noteLost: () => undefined,
    restartForShards: () => true, log, countSetting: () => o.setting ?? null, reshardOverlap: () => true,
    memoryReading: () => null,
    ...(o.standby ? { standby: { attempt: 'att-1', count: 8, onEnd: () => undefined } } : {}),
  };
  claims = new ShardClaims(deps);
  return { claims, calls, lines };
}

const local = (n: number | null) => async () => n;

describe('rd1: the boot page read before the first take (NB9 74)', () => {
  it('reads no page once a stop began', async () => {
    const r = rig({ stopping: true, page: page(gate()), takes: [done(4, [0])] });
    expect(await r.claims.bootTake(local(4))).toBeNull();
    expect(r.calls.pages).toBe(0);
    expect(r.calls.takes).toHaveLength(0);
  });

  it('reads no page once the process stopped writing to its database', async () => {
    const r = rig({ page: page(gate()), takes: [done(4, [0])] });
    r.claims.stopServingForDatabase('the disk is full');
    expect(await r.claims.bootTake(local(4))).toBeNull();
    expect(r.calls.pages).toBe(0);
    expect(r.calls.takes).toHaveLength(0);
  });

  const target8 = gate({ metaCount: 4, target: 8 });
  const directTake = (req: TakeRequest | undefined) => {
    expect(req?.localCount).toBe(8);
    expect(req?.writesMeta).toEqual({ kind: 'direct', from: 4 });
  };
  const bootTakeUnderLocal = (req: TakeRequest | undefined) => {
    expect(req?.localCount).toBe(4);
    expect(req?.writesMeta).toBeUndefined();
  };

  it('takes under the stored count while one live row of it remains, with a released row beside it', async () => {
    const r = rig({ page: page(target8, [row(4, 0), row(4, 1, { released: true })]), takes: [done(4, [0])] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    bootTakeUnderLocal(r.calls.takes[0]);
  });

  it('writes the wanted count directly when no row of the stored count is live', async () => {
    const r = rig({ page: page(target8, [row(4, 0, { released: true }), row(4, 1, { expiresUpMs: 900 })]), takes: [done(8, [0])] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    directTake(r.calls.takes[0]);
  });

  it('counts a row whose expiry equals the read time as not live', async () => {
    const r = rig({ page: page(target8, [row(4, 0, { expiresUpMs: 1000 })]), takes: [done(8, [0])] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    directTake(r.calls.takes[0]);
  });

  it('counts a row that expires after the read time as live', async () => {
    const r = rig({ page: page(target8, [row(4, 0, { expiresUpMs: 1001 })]), takes: [done(4, [0])] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    bootTakeUnderLocal(r.calls.takes[0]);
  });

  it('ignores the recommendation for W while FLEET_SHARD_COUNT is set', async () => {
    const r = rig({ setting: 4, page: page(gate({ metaCount: 4 })), takes: [done(4, [0])] });
    expect(await r.claims.bootTake(local(8))).not.toBeNull();
    expect(r.calls.takes[0]?.writesMeta).toBeUndefined();
    expect(r.calls.takes[0]?.countSetting).toBe(4);
  });

  it('takes the recommendation as W while FLEET_SHARD_COUNT is unset', async () => {
    const r = rig({ setting: null, page: page(gate({ metaCount: 4 })), takes: [done(8, [0])] });
    expect(await r.claims.bootTake(local(8))).not.toBeNull();
    expect(r.calls.takes[0]?.localCount).toBe(8);
    expect(r.calls.takes[0]?.writesMeta).toEqual({ kind: 'direct', from: 4 });
  });

  it('writes no count change for a stopping attempt without a to_count', async () => {
    const r = rig({ page: page(gate({ attempt: 'att-1', state: 'stopping', fromCount: 4, toCount: null, metaCount: 4 })), takes: [done(4, [0])] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    expect(r.calls.takes[0]?.localCount).toBe(4);
    expect(r.calls.takes[0]?.writesMeta).toBeUndefined();
  });
});

describe('rd1: the boot take after a count refusal (NB9 74 and 77)', () => {
  it('keeps the page read\'s live rows for the branch of the next try when meta is unchanged', async () => {
    const r = rig({
      page: page(gate({ attempt: 'att-0', state: 'standby', fromCount: 4, toCount: 6, metaCount: 4 }), [row(4, 0, { released: true })]),
      takes: [{ kind: 'count', read: gate({ metaCount: 4, target: 8 }) }, done(8, [0])],
    });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    expect(r.calls.takes[0]?.writesMeta).toBeUndefined();
    expect(r.calls.takes[1]?.localCount).toBe(8);
    expect(r.calls.takes[1]?.writesMeta).toEqual({ kind: 'direct', from: 4 });
  });
});

describe('rd1: the boot take\'s held answers (NB9 56, L13 and L14)', () => {
  it('logs L14 again for a new attempt', async () => {
    const stopping = (attempt: string) => gate({ attempt, state: 'stopping', fromCount: 4, toCount: 8, metaCount: 4 });
    const r = rig({
      page: page(stopping('att-1')),
      takes: [
        { kind: 'held', read: stopping('att-1'), rows: [held(4, 0)] },
        { kind: 'count', read: stopping('att-2') },
        { kind: 'held', read: stopping('att-2'), rows: [held(4, 0)] },
        done(8, [0]),
      ],
    });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    expect(r.calls.takes[2]?.writesMeta).toEqual({ kind: 'change', attempt: 'att-2' });
    const line = l14Line(8, 4, [held(4, 0)]);
    expect(r.lines.filter(l => l === line)).toHaveLength(2);
  });

  it('logs L13 again for a new attempt', async () => {
    const flipped = (attempt: string) => gate({ attempt, state: 'flipped', fromCount: 4, toCount: 8, metaCount: 8 });
    const r = rig({
      takes: [
        { kind: 'held', read: flipped('att-1'), rows: [held(4, 0)] },
        { kind: 'held', read: flipped('att-1'), rows: [held(4, 0)] },
        { kind: 'held', read: flipped('att-2'), rows: [held(4, 0)] },
        done(8, [0]),
      ],
    });
    expect(await r.claims.bootTake(local(8))).not.toBeNull();
    const line = l13Line(8, 4, [held(4, 0)]);
    expect(r.lines.filter(l => l === line)).toHaveLength(2);
  });

  it('drops the direct change without L32 when a row of the stored count is held', async () => {
    const r = rig({
      page: page(gate({ metaCount: 4, target: 8 })),
      takes: [{ kind: 'held', read: gate({ metaCount: 4, target: 8 }), rows: [held(4, 0), held(2, 1, 'C')] }, done(4, [0])],
    });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    expect(r.calls.takes[0]?.writesMeta).toEqual({ kind: 'direct', from: 4 });
    expect(r.calls.takes[1]?.writesMeta).toBeUndefined();
    expect(r.calls.takes[1]?.localCount).toBe(4);
    expect(r.lines.some(l => l.includes('Not taking shards of the'))).toBe(false);
  });
});

describe('rd1: L17 at the boot take (NB9 4, 13 and 74)', () => {
  it('logs no L17 when the setting equals the target the read holds', async () => {
    const r = rig({ setting: 8, takes: [done(4, [0], gate({ metaCount: 4, target: 8 }))] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    expect(r.lines.some(l => l.includes('FLEET_SHARD_COUNT on this machine is'))).toBe(false);
  });

  it('names Discord\'s recommendation when the read holds no target', async () => {
    const r = rig({ setting: 8, takes: [done(4, [0], gate({ metaCount: 4, target: null, targetBy: 'B', targetAt: 0 }))] });
    expect(await r.claims.bootTake(local(4))).not.toBeNull();
    const l17 = r.lines.filter(l => l.includes('FLEET_SHARD_COUNT on this machine is 8'));
    expect(l17).toHaveLength(1);
    expect(l17[0]).toContain("from Discord's recommendation");
    expect(l17[0]).not.toContain('set on B');
  });
});

describe('rd1: a database stop during the boot take (NB5 E2)', () => {
  it('grants nothing when the database stop comes while the take is on the wire', async () => {
    const r = rig({ takes: [done(4, [0, 1])], onTake: (_req, claims) => claims.stopServingForDatabase('the disk is full') });
    expect(await r.claims.bootTake(local(4))).toBeNull();
  });
});

describe('rd1: the first renewal (NB5 E2)', () => {
  it('answers false when the database stop comes while the renewal is on the wire', async () => {
    const r = rig({
      renew: async (req, claims) => {
        claims.stopServingForDatabase('the disk is full');
        return { rows: req.pairs.map(p => ({ ...p, mine: true, released: false })), at: 1_000_000, priorProcess: ME.processId };
      },
    });
    expect(await r.claims.firstRenewal()).toBe(false);
    expect(r.calls.renews).toHaveLength(1);
  });

  it('sends no renewal after a database stop, even once a move resumed the lanes', async () => {
    const r = rig();
    r.claims.stopServingForDatabase('the disk is full');
    expect(await r.claims.moveClaims({ address: 'db2', generation: 2 })).toBe(true);
    expect(r.calls.renews.map(c => c.move)).toEqual([true]);
    expect(await r.claims.firstRenewal()).toBe(false);
    expect(r.calls.renews.map(c => c.move)).toEqual([true]);
  });
});

describe('rd1: the renewal lane (NB4 decision 5, NB9 C14)', () => {
  it('records no failure when the gate dropped the renewal', async () => {
    const r = rig({ renew: async () => { throw new ClaimPausedError(); } });
    await r.claims.renewOnce();
    expect(r.claims.latestFailureClass()).toBeNull();
    expect(r.claims.snapshot().renewalError).toBeNull();
  });

  it('keeps the last real failure when a later renewal is dropped by the gate', async () => {
    let n = 0;
    const r = rig({ renew: async () => { n += 1; throw n === 1 ? new Error('socket hang up') : new ClaimPausedError(); } });
    await r.claims.renewOnce();
    await r.claims.renewOnce();
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'unreachable', detail: 'socket hang up' });
  });

  it('logs no L16 for a standby renewal and sends no heartbeat renewal', async () => {
    const r = rig({
      standby: true,
      renewStandby: async () => ({ rows: [], at: 1_000_000, priorProcess: 'p-other', targetWritten: { from: 4, to: 8 } }),
    });
    expect(await r.claims.firstRenewal()).toBe(true);
    await r.claims.renewOnce();
    expect(r.calls.renews).toHaveLength(0);
    expect(r.lines).not.toContain(l16Line(4, 8));
    expect(r.lines.some(l => l.includes('node-a'))).toBe(false);
  });

  it('names the missing standby renewal in the failure', async () => {
    const r = rig({ standby: true });
    await r.claims.renewOnce();
    expect(r.claims.latestFailureClass()).toEqual({ kind: 'unreachable', detail: 'this claims store has no standby renewal' });
  });
});

describe('rd1: the redraw (NB9 29)', () => {
  const pairs: Pair[] = [{ shardCount: 8, shardId: 0, claim: 3 }];
  const answer = async (): Promise<RedrawAnswer> => ({ kind: 'done', pairs, closed: null });

  it('refuses a redraw that names another process, naming both', async () => {
    const r = rig({ redraw: answer });
    await expect(r.claims.redraw({ count: 8, processId: 'p-z', pairs })).rejects.toThrow("the redraw names process p-z, not this process's p-a");
    expect(r.calls.redraws).toBe(0);
  });

  it('sends no redraw once a stop began and serves nothing', async () => {
    const r = rig({ stopping: true, redraw: answer });
    expect(await r.claims.redraw({ count: 8, processId: ME.processId, pairs })).toBeNull();
    expect(r.calls.redraws).toBe(0);
    expect(r.claims.ownCount()).toBeNull();
    expect(r.claims.heldPairs()).toEqual([]);
  });
});
