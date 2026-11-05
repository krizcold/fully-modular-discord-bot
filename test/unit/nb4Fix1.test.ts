import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSourceText } from '../helpers/sourceText';

const h = vi.hoisted(() => ({
  gateway: [] as Array<{ info: any; error: string | null }>,
  gatewayCalls: 0,
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async importOriginal => {
  const real: any = await importOriginal();
  return {
    ...real,
    fetchGatewayInfoResult: vi.fn(async () => {
      h.gatewayCalls++;
      return h.gateway.shift() ?? { info: null, error: 'HTTP 401' };
    }),
  };
});

vi.mock('../../src/utils/envLoader', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, resolveDataBackend: () => 'postgres', loadCredentials: () => ({ DATA_BACKEND_URL: 'postgres://fake/fake' }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getDataBootStatus: () => ({ state: 'serving' }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getDataReadiness: () => ({ onLeaseChanged: () => undefined }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, cleanOrphanTmpFiles: vi.fn(async () => {}) };
});

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getNodeId: () => 'node-a', getNodeName: () => 'Node A', getAppVersion: () => '1.0.0' };
});

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: () => undefined,
    isStarted: () => false,
    start: async () => 'ok',
    stop: async () => {},
    getClient: () => null,
  };
  return { getIngestService: () => fake };
});

import { ShardClaims, releaseFailureLine, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { ClaimStore, classifyFailure, type RenewAnswer, type RenewRequest, type PageRead } from '../../src/bot/internalSetup/fleet/claimStore';
import { _setClaimStoreFactory, bootShards, TOKEN_REFUSED_LINE } from '../../src/bot/internalSetup/fleet/shardBoot';
import { _setFleetStateSources, getFleetState } from '../../src/bot/internalSetup/fleet/state';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// Round 1 fixes of NB4: a renewal judged by the pairs it carried, a loss in the exit drain, the restart wait reason,
// the page read after a stop, the work lane's single connection, the release's one bound, a take of constant
// statements and a 401 while resolving the count.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class GatedStore extends MemClaimStore {
  holdNextRenewal = false;
  private renewalGate: (() => void) | null = null;
  renewalsSent = 0;
  renewalsInFlight = 0;
  maxRenewalsInFlight = 0;
  workInFlight = 0;
  maxWorkInFlight = 0;
  pageReads = 0;
  rowReads = 0;
  holdNextPage = false;
  private pageGate: (() => void) | null = null;

  openRenewal(): void { const go = this.renewalGate; this.renewalGate = null; go?.(); }
  openPage(): void { const go = this.pageGate; this.pageGate = null; go?.(); }
  get renewalHeld(): boolean { return this.renewalGate !== null; }

  async renew(request: RenewRequest): Promise<RenewAnswer> {
    this.renewalsSent += 1;
    this.renewalsInFlight += 1;
    this.maxRenewalsInFlight = Math.max(this.maxRenewalsInFlight, this.renewalsInFlight);
    try {
      if (this.holdNextRenewal) {
        this.holdNextRenewal = false;
        await new Promise<void>(resolve => { this.renewalGate = resolve; });
      }
      return await super.renew(request);
    } finally {
      this.renewalsInFlight -= 1;
    }
  }

  private async onWork<T>(fn: () => Promise<T>): Promise<T> {
    this.workInFlight += 1;
    this.maxWorkInFlight = Math.max(this.maxWorkInFlight, this.workInFlight);
    try { return await fn(); } finally { this.workInFlight -= 1; }
  }

  async readPage(): Promise<PageRead> {
    return this.onWork(async () => {
      this.pageReads += 1;
      if (this.holdNextPage) {
        this.holdNextPage = false;
        await new Promise<void>(resolve => { this.pageGate = resolve; });
      }
      return super.readPage();
    });
  }

  async readRow(shardCount: number, shardId: number) {
    return this.onWork(async () => { this.rowReads += 1; return super.readRow(shardCount, shardId); });
  }
}

function rig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new GatedStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { stopStep: 0, lost: [] as number[][], restarts: [] as string[] };
  const state = { fit: null as string | null, stopping: false, restart: true };
  const claims = new ShardClaims({
    store,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    fitness: () => state.fit,
    gateClosed: () => false,
    isStopping: () => state.stopping,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: () => undefined,
    noteLost: lost => { calls.lost.push(lost.map(p => p.shardId)); },
    restartForShards: reason => { calls.restarts.push(reason); return state.restart; },
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  return { store, claims, calls, state, lines };
}

async function booted(r: ReturnType<typeof rig>, count = 2) {
  r.claims.start();
  expect(await r.claims.firstRenewal()).toBe(true);
  const taken = await r.claims.bootTake(async () => count);
  r.claims.noteGranted();
  return taken!;
}

function freeShard3(r: ReturnType<typeof rig>) {
  Object.assign(r.store.rows.get('4:3')!, { released: false, holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
  r.claims['held'] = r.claims['held'].filter((p: Pair) => p.shardId !== 3);
}

describe('a renewal is judged by the pairs it carried (NB4-DL-1, NB4-RUN-1)', () => {
  it('a renewal on the wire across the boot take finds no loss, and the next renewal carries the taken pairs', async () => {
    const r = rig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    r.store.holdNextRenewal = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewalHeld).toBe(true);
    const taken = await r.claims.bootTake(async () => 2);
    expect(taken!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    r.claims.noteGranted();
    r.store.openRenewal();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.lost).toEqual([]);
    expect(r.calls.stopStep).toBe(0);
    expect(r.claims.stoppedServing()).toBe(false);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    expect(r.calls.lost).toEqual([]);
    expect(r.lines().filter(l => l.includes('no longer held') || l.includes('claim row'))).toEqual([]);
  });

  it('a renewal on the wire across a reservation finds no loss, and the next one carries the reservation', async () => {
    const r = rig();
    await booted(r, 4);
    freeShard3(r);
    r.store.takeMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.takes.length).toBe(2);
    r.store.holdNextRenewal = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewalHeld).toBe(true);
    r.store.takeMode = 'ok';
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
    r.store.openRenewal();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls.lost).toEqual([]);
    expect(r.calls.stopStep).toBe(0);
    expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).toContain(3);
    expect(r.calls.lost).toEqual([]);
  });

  it('a carried pair that does not come back is still a loss', async () => {
    const r = rig();
    await booted(r);
    Object.assign(r.store.rows.get('2:1')!, { claim: 99, holderProcess: 'p-other' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.lost).toEqual([[1]]);
  });
});

describe('a loss in the exit drain (NB4-DL-2)', () => {
  it('stops serving, starts no leave and asks no restart; the release names the lost shard', async () => {
    const r = rig();
    await booted(r);
    r.state.stopping = true;
    r.claims.beginStop();
    Object.assign(r.store.rows.get('2:1')!, { claim: 99, holderProcess: 'p-other', holderNode: 'node-b', holderName: 'B' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.calls.lost).toEqual([]);
    expect(r.calls.restarts).toEqual([]);
    await r.claims.finishStop();
    expect(r.lines()).toContain("[Shards] Released shards 0: kept for this machine's next start for 30 s, then free to any machine with room");
    expect(r.lines()).toContain('[Shards] Shard 1 was no longer held by this process at the release');
  });
});

describe('the restart wait reason (ruling 5, NB4-DL-3, NB4-RUN-4)', () => {
  it('shows the failing fitness key while the request is held back, and clears a request never sent at a loss', async () => {
    const r = rig();
    r.state.restart = false;
    await booted(r, 4);
    freeShard3(r);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot().pendingRestart).toBe('take shard 3');
    r.state.fit = 'a save is failing';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: 'take shard 3', restartWaiting: 'a save is failing' });
    Object.assign(r.store.rows.get('4:0')!, { claim: 99, holderProcess: 'p-other' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.stopStep).toBe(1);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: null, restartWaiting: null });
  });

  it('a sent request waits for nothing', async () => {
    const r = rig();
    await booted(r, 4);
    freeShard3(r);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.restarts).toEqual(['take shard 3']);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: 'take shard 3', restartWaiting: null });
  });

  it('the fleet page shows the wait only while the request waits', () => {
    const src = readSourceText(__dirname, '../../src/webui/public/components/usage/FleetView.jsx');
    const fn = (name: string) => {
      const start = src.indexOf(`function ${name}(`);
      const end = src.indexOf('\n}\n', start);
      return src.slice(start, end + 2);
    };
    const body = ['fleetFormatDuration', 'fleetRenewalError', 'fleetReadError', 'fleetClaimsAge', 'fleetPendingRestart'].map(fn).join('\n');
    const api = new Function(`${body}\nreturn { fleetClaimsAge, fleetPendingRestart };`)() as {
      fleetClaimsAge: (f: object) => string;
      fleetPendingRestart: (f: object) => string;
    };
    expect(api.fleetPendingRestart({ pendingRestart: 'take shard 3', restartWaiting: 'a save is failing' })).toBe('Restarting to take shard 3 (waiting: a save is failing)');
    expect(api.fleetPendingRestart({ pendingRestart: 'take shard 3', restartWaiting: null })).toBe('Restarting to take shard 3');
    expect(api.fleetPendingRestart({ pendingRestart: null, restartWaiting: null })).toBe('');
    expect(api.fleetClaimsAge({ claimsReadAgoMs: 3000, claimsStale: false, renewalError: null, claimsReadError: null })).toBe('');
    expect(api.fleetClaimsAge({ claimsReadAgoMs: 40_000, claimsStale: true, renewalError: null, claimsReadError: null })).toBe('Claims as last read 40s ago');
    expect(api.fleetClaimsAge({ claimsReadAgoMs: 40_000, claimsStale: true, renewalError: null, claimsReadError: { kind: 'timeout' } })).toBe('Claims as last read 40s ago; the claims read timed out');
    expect(api.fleetClaimsAge({ claimsReadAgoMs: 40_000, claimsStale: true, renewalError: { kind: 'refused' }, claimsReadError: null })).toBe('Claims as last read 40s ago; the database refused the login');
  });
});

describe('the page read after a stop began (NB4-RUN-3)', () => {
  it('goes on after a loss, and a failed read is recorded and cleared by the next one', async () => {
    const r = rig();
    await booted(r);
    Object.assign(r.store.rows.get('2:1')!, { claim: 99, holderProcess: 'p-other' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.lost).toEqual([[1]]);
    const reads = r.store.pageReads;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.pageReads).toBeGreaterThan(reads);
    r.store.readMode = Object.assign(new Error('canceling statement'), { code: '57014' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot().pageReadError).toMatchObject({ kind: 'error', code: '57014' });
    r.store.readMode = 'ok';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot().pageReadError).toBeNull();
  });

  it('the fleet state moves the read times on by the read age and marks a read older than 2R', async () => {
    const r = rig();
    await booted(r);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const runtime = { getCurrent: () => null, shardStatuses: () => [], getStillConnected: () => [] };
    const ledger = { getRecommendation: () => null, getBudgetInfo: () => null };
    _setFleetStateSources({
      nodeId: 'node-a', nodeName: 'A', appVersion: '1', shardSource: 'discord', recommendedShards: null, recommendedAt: null,
      runtime: runtime as any, ingest: { getClient: () => null } as any, ledger: ledger as any, claims: r.claims,
    });
    const fresh = getFleetState();
    expect(fresh.claimsStale).toBe(false);
    const freshExpiry = fresh.claims.find(c => c.shardId === 0)!.expiresInMs!;
    const freshSeen = fresh.nodes[0].seenAgoMs;
    r.store.renewMode = 'hang';
    vi.advanceTimersByTime(12_000);
    const old = getFleetState();
    expect(old.claimsStale).toBe(true);
    expect(old.claimsReadAgoMs).toBeGreaterThanOrEqual(12_000);
    expect(old.claims.find(c => c.shardId === 0)!.expiresInMs).toBe(Math.max(freshExpiry - (old.claimsReadAgoMs! - fresh.claimsReadAgoMs!), 0));
    expect(old.nodes[0].seenAgoMs).toBe(freshSeen + (old.claimsReadAgoMs! - fresh.claimsReadAgoMs!));
  });
});

describe('the work lane holds one query at a time (NB4-RUN-7)', () => {
  it('the loss line read waits for the page read on the wire', async () => {
    const r = rig();
    await booted(r);
    r.store.holdNextPage = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    Object.assign(r.store.rows.get('2:1')!, { claim: 99, holderProcess: 'p-other' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.lost).toEqual([[1]]);
    expect(r.store.rowReads).toBe(0);
    r.store.openPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.rowReads).toBe(1);
    expect(r.store.maxWorkInFlight).toBe(1);
    expect(r.lines().some(l => l.startsWith("[Shards] Shard 1's claim row holds claim 99"))).toBe(true);
  });

  it('a take acknowledged after D renews on the renewal lane, after the renewal on the wire', async () => {
    const r = rig();
    r.claims.start();
    expect(await r.claims.firstRenewal()).toBe(true);
    r.store.takeMode = 'hang';
    const boot = r.claims.bootTake(async () => 2);
    await vi.advanceTimersByTimeAsync(T.deadlineMs + 1);
    r.store.holdNextRenewal = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewalHeld).toBe(true);
    const sent = r.store.renewalsSent;
    r.store.takeMode = 'ok';
    r.store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.store.renewalsSent).toBe(sent);
    r.store.openRenewal();
    const taken = await boot;
    expect(taken!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).toEqual([0, 1]);
    expect(r.store.maxRenewalsInFlight).toBe(1);
  });
});

describe('a 401 while resolving the count ends the boot take (NB4-RUN-8)', () => {
  it('bootTake answers null once giveUp answers true, and sends no take', async () => {
    const r = rig();
    r.claims.start();
    await r.claims.firstRenewal();
    let refused = false;
    const result = await r.claims.bootTake(async () => { refused = true; return null; }, () => refused);
    expect(result).toBeNull();
    expect(r.store.takes).toEqual([]);
  });

  it('the boot logs the token line once, fetches no more and runs no shard', async () => {
    const store = new MemClaimStore(() => Date.now());
    _setClaimStoreFactory(() => store);
    h.gateway.push({ info: null, error: 'connect ECONNRESET' }, { info: null, error: 'HTTP 401' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = await bootShards();
    expect(ctx.shardCount).toBe(0);
    expect(errors.mock.calls.filter(c => c[0] === TOKEN_REFUSED_LINE)).toHaveLength(1);
    expect(h.gatewayCalls).toBe(2);
    expect(store.takes).toEqual([]);
    _setClaimStoreFactory(null);
  });
});

class FakeClient {
  queries: string[] = [];
  released: Array<boolean | undefined> = [];
  constructor(private readonly answer: (text: string, values: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>) {}
  query(config: string | { text: string; values?: unknown[] }, values?: unknown[]) {
    const text = typeof config === 'string' ? config : config.text;
    this.queries.push(text);
    return this.answer(text, (typeof config === 'string' ? values : config.values) ?? []);
  }
  release(destroy?: boolean) { this.released.push(destroy); }
}

function storeWith(connect: () => Promise<FakeClient>): ClaimStore {
  const store = new ClaimStore('postgres://fake/fake', T);
  const pool = (store as any).pool;
  void pool.end().catch(() => undefined);
  (store as any).pool = { connect, end: async () => undefined, on: () => undefined };
  return store;
}

const never = () => new Promise<never>(() => undefined);
const me = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };

describe('the release: one 2 s bound, and sent means COMMIT sent (NB4-DL-4, NB4-RUN-5)', () => {
  it('a connect of 1.5 s leaves 0.5 s for the transaction; a lock wait cut off there was never committed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const client = new FakeClient(async text => (text.includes('pg_advisory_xact_lock') ? never() : { rows: [] }));
    const store = storeWith(() => new Promise(resolve => setTimeout(() => resolve(client), 1500)));
    const onSent = vi.fn();
    const outcome = store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }, onSent).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(classifyFailure(error)).toEqual({ kind: 'timeout' });
    expect(onSent).not.toHaveBeenCalled();
    expect(client.released).toContain(true);
    expect(releaseFailureLine([{ shardCount: 2, shardId: 0, claim: 1 }], classifyFailure(error), false))
      .toBe('[Shards] Could not reach the database to release shards 0 (timeout); any machine with room may take them once their claims expire');
  });

  it('a COMMIT with no answer was sent: its line says it may still have applied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const client = new FakeClient(async text => {
      if (text === 'COMMIT') return never();
      if (text.includes('claim_clock') && !text.includes('UPDATE')) return { rows: [{ up_ms: '0', u_prime: '0', now_ms: 0 }] };
      return { rows: [] };
    });
    const store = storeWith(async () => client);
    const onSent = vi.fn();
    const outcome = store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }, onSent).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await outcome;
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(client.queries.indexOf('COMMIT')).toBeGreaterThan(-1);
    expect(releaseFailureLine([{ shardCount: 2, shardId: 0, claim: 1 }], classifyFailure(error), true))
      .toMatch(/got no answer within 2 s \(timeout\); it may still have applied/);
  });

  it('a server error before COMMIT is the server error line', () => {
    expect(releaseFailureLine([{ shardCount: 2, shardId: 0, claim: 1 }], { kind: 'error', code: '55P03', message: 'lock timeout' }, false))
      .toBe('[Shards] Could not release shards 0 (SQLSTATE 55P03 lock timeout); any machine with room may take them once their claims expire');
  });
});

describe('the take sends the same number of statements for any number of shards (NB4-RUN-6)', () => {
  async function takeCount(k: number, floor = 0, drawFrom = 1, client = takeClient(floor, drawFrom)) {
    const store = storeWith(async () => client);
    const answer = await store.take({ me, capacity: k, ttlMs: T.ttlMs, boot: true, known: [], localCount: k, reserve: false });
    return { client, answer };
  }

  function takeClient(floor: number, drawFrom: number) {
    return new FakeClient(async (text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (text.includes('FROM smdb_data.claim_clock')) return { rows: [{ up_ms: '0', u_prime: '0', now_ms: 0 }] };
      if (text.includes('AS floor')) return { rows: [{ floor: String(floor) }] };
      if (text.includes('generate_series')) return { rows: Array.from({ length: Number(values[0]) }, (_, i) => ({ n: String(drawFrom + i) })) };
      if (text.includes('INSERT INTO smdb_data.shard_claims')) {
        const ids = values[1] as number[];
        const claims = values[2] as number[];
        return { rows: ids.map((id, i) => ({ shard_id: id, claim: String(claims[i]) })) };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('2 shards and 200 shards cost the same statements', async () => {
    const small = await takeCount(2);
    const large = await takeCount(200);
    expect(small.answer.kind === 'done' && small.answer.taken.length).toBe(2);
    expect(large.answer.kind === 'done' && large.answer.taken.length).toBe(200);
    expect(large.client.queries.length).toBe(small.client.queries.length);
    expect(large.client.queries.filter(q => q.includes('nextval'))).toHaveLength(1);
  });

  it('numbers drawn at or below the floor are raised above it, distinct, and the sequence is set to the last', async () => {
    const { client, answer } = await takeCount(3, 50, 10);
    expect(answer.kind === 'done' && answer.taken.map(t => t.pair.claim)).toEqual([51, 52, 53]);
    expect(client.queries.filter(q => q.includes('setval'))).toHaveLength(1);
  });

  it('an unusable number rejects the take before any write', async () => {
    const client = takeClient(Number.MAX_SAFE_INTEGER, 1);
    const outcome = takeCount(2, Number.MAX_SAFE_INTEGER, 1, client).then(() => null, (e: unknown) => e);
    expect(await outcome).toBeInstanceOf(Error);
    expect(client.queries.filter(q => q.includes('INSERT INTO smdb_data.shard_claims') || q.includes('setval') || q === 'COMMIT')).toEqual([]);
    expect(client.released).toContain(true);
  });
});
