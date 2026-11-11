import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { ShardClaims, type ShardClaimsDeps, releaseFailureLine } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ClaimFailure, ClaimStore, classifyFailure, RELEASE_SQL } from '../../src/bot/internalSetup/fleet/claimStore';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { readSourceText } from '../helpers/sourceText';
import { stopSteps } from '../helpers/stopRig';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { setBackendKind } from '../helpers/backendKind';
import { storeGuild } from '../helpers/gateRig';

// Round 3 fixes of NB4: the release's failure line by what reached the server, a page read that fails asks no
// restart for a return, the deadline timer fired early waits out the rest of D, an operator delete or restore asks
// the serving gate after its last await, and the stop steps run in their order and always exit.

const T = claimTimings(30);
const skew = { perf: 0, wall: 0 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  skew.perf = 0;
  skew.wall = 0;
  setStoppedServingHook(null);
  setGuildDataBackend(null);
  setBackendKind(null);
});

const fatal = () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' });

function rig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { stopStep: 0, restarts: [] as string[] };
  const state = { fit: null as string | null, restart: true };
  const claims = new ShardClaims({
    store,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    clocks: () => ({ perf: performance.now() + skew.perf, wall: Date.now() + skew.wall }),
    fitness: () => state.fit,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => { calls.stopStep += 1; },
    noteLapsed: () => undefined,
    noteLost: () => undefined,
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
  await r.claims.bootTake(async () => count);
  r.claims.noteGranted();
}

describe('the release failure line by what reached the server (NB4-R3-DL-2)', () => {
  const asked = [{ shardCount: 2, shardId: 0, claim: 1 }, { shardCount: 2, shardId: 1, claim: 2 }];

  it('a FATAL or PANIC answer keeps its severity; an ERROR answer does not carry one', () => {
    expect(classifyFailure(fatal())).toEqual({ kind: 'error', code: '57P01', message: 'terminating connection due to administrator command', severity: 'FATAL' });
    expect(classifyFailure(Object.assign(new Error('x'), { code: 'XX000', severity: 'PANIC' }))).toMatchObject({ severity: 'PANIC' });
    expect(classifyFailure(Object.assign(new Error('lock'), { code: '55P03', severity: 'ERROR' }))).toEqual({ kind: 'error', code: '55P03', message: 'lock' });
  });

  it('a COMMIT answered by FATAL was answered by an error and may still have applied', () => {
    expect(releaseFailureLine(asked, classifyFailure(fatal()), true, true))
      .toBe('[Shards] The release of shards 0, 1 was answered by an error that may follow a landed COMMIT (error: SQLSTATE 57P01 terminating connection due to administrator command); it may still have applied, and otherwise any machine with room may take them once their claims expire');
  });

  it('a COMMIT sent with no answer keeps the no-answer line', () => {
    expect(releaseFailureLine(asked, { kind: 'timeout' }, true, true))
      .toBe('[Shards] The release of shards 0, 1 got no answer within 2 s (timeout); it may still have applied, and otherwise any machine with room may take them once their claims expire');
  });

  it('a COMMIT answered by 57P01 with a localized severity may still have applied; 23505 at ERROR did not', () => {
    const localized = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'ВАЖНО' });
    expect(releaseFailureLine(asked, classifyFailure(localized), true, true))
      .toBe('[Shards] The release of shards 0, 1 was answered by an error that may follow a landed COMMIT (error: SQLSTATE 57P01 terminating connection due to administrator command); it may still have applied, and otherwise any machine with room may take them once their claims expire');
    const refused = Object.assign(new Error('duplicate key value'), { code: '23505', severity: 'ERROR' });
    expect(releaseFailureLine(asked, classifyFailure(refused), true, true))
      .toBe('[Shards] Could not release shards 0, 1 (SQLSTATE 23505 duplicate key value); any machine with room may take them once their claims expire');
  });

  it('a COMMIT answered by ERROR is the server error line', () => {
    expect(releaseFailureLine(asked, { kind: 'error', code: '40001', message: 'could not serialize access' }, true, true))
      .toBe('[Shards] Could not release shards 0, 1 (SQLSTATE 40001 could not serialize access); any machine with room may take them once their claims expire');
  });

  it('a bound that fires after the connect but before the COMMIT says the database was reached and nothing applied', () => {
    expect(releaseFailureLine(asked, { kind: 'timeout' }, false, true))
      .toBe('[Shards] The release of shards 0, 1 got no answer before its COMMIT was sent (timeout), so it did not apply; any machine with room may take them once their claims expire');
    expect(releaseFailureLine(asked, { kind: 'timeout' }, false, false))
      .toBe('[Shards] Could not reach the database to release shards 0, 1 (timeout); any machine with room may take them once their claims expire');
  });

  it('finishStop logs the may-have-applied line for a FATAL COMMIT', async () => {
    const r = rig();
    await booted(r);
    (r.store as any).release = async (_request: unknown, onSent?: () => void, onConnected?: () => void) => {
      onConnected?.();
      onSent?.();
      throw new ClaimFailure(classifyFailure(fatal()), fatal());
    };
    await r.claims.finishStop();
    expect(r.lines()).toContain('[Shards] The release of shards 0, 1 was answered by an error that may follow a landed COMMIT (error: SQLSTATE 57P01 terminating connection due to administrator command); it may still have applied, and otherwise any machine with room may take them once their claims expire');
  });

  it('finishStop logs the not-applied line for a bound that fires during the release statement', async () => {
    const r = rig();
    await booted(r);
    (r.store as any).release = async (_request: unknown, _onSent?: () => void, onConnected?: () => void) => {
      onConnected?.();
      throw new ClaimFailure({ kind: 'timeout' });
    };
    await r.claims.finishStop();
    expect(r.lines()).toContain('[Shards] The release of shards 0, 1 got no answer before its COMMIT was sent (timeout), so it did not apply; any machine with room may take them once their claims expire');
  });

  class FakeClient {
    queries: string[] = [];
    released: Array<boolean | undefined> = [];
    constructor(private readonly answer: (text: string) => Promise<{ rows: any[] }>) {}
    query(config: string | { text: string }) {
      const text = typeof config === 'string' ? config : config.text;
      this.queries.push(text);
      return this.answer(text);
    }
    release(destroy?: boolean) { this.released.push(destroy); }
  }

  function storeWith(connect: () => Promise<FakeClient>): ClaimStore {
    const store = new ClaimStore('postgres://fake/fake', T);
    void (store as any).pool.end().catch(() => undefined);
    (store as any).pool = { connect, end: async () => undefined, on: () => undefined };
    return store;
  }
  const me = { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' };
  const never = () => new Promise<never>(() => undefined);

  it('ClaimStore.release: a FATAL COMMIT comes back with its severity, after both callbacks', async () => {
    const client = new FakeClient(async text => {
      if (text === 'COMMIT') throw fatal();
      if (text.includes('claim_clock') && !text.includes('UPDATE')) return { rows: [{ up_ms: '0', u_prime: '0', now_ms: 0 }] };
      return { rows: [] };
    });
    const store = storeWith(async () => client);
    const onSent = vi.fn();
    const onConnected = vi.fn();
    const error = await store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }, onSent, onConnected).then(() => null, (e: unknown) => e);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(classifyFailure(error)).toMatchObject({ kind: 'error', code: '57P01', severity: 'FATAL' });
  });

  it('ClaimStore.release: a bound during the release statement was connected and never sent; a connect that hangs was neither', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const client = new FakeClient(async text => (text === RELEASE_SQL ? never() : { rows: [{ up_ms: '0', u_prime: '0', now_ms: 0 }] }));
    const store = storeWith(async () => client);
    const onSent = vi.fn();
    const onConnected = vi.fn();
    const outcome = store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }, onSent, onConnected).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(classifyFailure(await outcome)).toEqual({ kind: 'timeout' });
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
    expect(client.queries).not.toContain('COMMIT');

    const hung = storeWith(never);
    const connected = vi.fn();
    const second = hung.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }, undefined, connected).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(classifyFailure(await second)).toEqual({ kind: 'timeout' });
    expect(connected).not.toHaveBeenCalled();
  });
});

describe('a page read that fails asks no restart for a return decided earlier (NB4-R3-RUN-1)', () => {
  it('the return waits for a page read that decides it again', async () => {
    const r = rig();
    await booted(r);
    r.state.fit = 'a save is failing';
    r.state.restart = false;
    r.claims['returnList'] = [{ shardId: 1, receiver: 'node-b', move: false }];
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.calls.restarts.at(-1)).toBe('return shard 1 to node-b');
    const asked = r.calls.restarts.length;
    r.store.readMode = Object.assign(new Error('canceling statement'), { code: '57014' });
    r.state.fit = null;
    r.state.restart = true;
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(r.calls.restarts.slice(asked)).toEqual([]);
    expect(r.claims.snapshot().pendingRestart).toBeNull();
  });
});

describe('a deadline timer that fires before D on the measured clocks (NB4-R3-RUN-2)', () => {
  it('lapses within a few ms after D, not R later', async () => {
    const r = rig();
    await booted(r);
    r.store.renewMode = 'hang';
    skew.perf = -2;
    skew.wall = -2;
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(r.calls.stopStep).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(r.calls.stopStep).toBe(1);
  });
});

describe('an operator delete or restore asks the serving gate after its last await (NB4-R2-2 residual)', () => {
  it('a delete whose flush outlasts D retires and evicts nothing', async () => {
    let stopped = false;
    setStoppedServingHook(() => stopped);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { guildId } = await storeGuild();
    const retireGuild = vi.fn(async () => ({ ok: true, moved: 1 }));
    setGuildDataBackend({ retireGuild } as never);
    const ws = getWorkingSet()!;
    vi.spyOn(ws, 'flushGuildNow').mockImplementation(async () => { stopped = true; return 'ok' as never; });
    const evict = vi.spyOn(ws, 'evict');
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'delete-namespace' })).toEqual({ ok: false, code: 'frozen' });
    expect(evict).not.toHaveBeenCalled();
    expect(retireGuild).not.toHaveBeenCalled();
  });

  it('a restore whose flush outlasts D sends no restore, and the set it held stays frozen', async () => {
    let stopped = false;
    setStoppedServingHook(() => stopped);
    const { guildId } = await storeGuild();
    const restoreGuild = vi.fn(async () => ({ ok: true, copied: 1, retiredAt: 5, reason: 'r', usedAt: 1000 }));
    setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), { restoreGuild }));
    const ws = getWorkingSet()!;
    vi.spyOn(ws, 'flushGuildNow').mockImplementation(async () => { stopped = true; return 'ok' as never; });
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'restore-graveyard' })).toEqual({ ok: false, code: 'frozen' });
    expect(restoreGuild).not.toHaveBeenCalled();
    expect(ws.stateOf(guildId)).toBe('frozen-retained');
  });

  it('a set the restore holds takes no freeze and no write, so the landed restore drops nothing unsaved', async () => {
    const { guildId } = await storeGuild();
    const ws = getWorkingSet()!;
    setGuildDataBackend(Object.assign(Object.create(PostgresBackend.prototype), {
      restoreGuild: async () => {
        ws.freeze(guildId);
        expect(ws.stateOf(guildId)).toBe('restoring');
        expect(ws.dirtyGuildIds()).not.toContain(guildId);
        return { ok: true, copied: 1, retiredAt: 5, reason: 'r', usedAt: 1000 };
      },
    }));
    expect(await restoreGuildFromGraveyard(guildId, 5)).toEqual({ ok: true, copied: 1, retiredAt: 5, reason: 'r', keptUntil: 1000 + 14 * 24 * 60 * 60 * 1000 });
    expect(ws.has(guildId)).toBe(false);
  });
});

describe('the stop steps (NB4-R3-T1)', () => {
  async function freshStop() {
    vi.resetModules();
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const order: string[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { order.push(`exit ${code}`); }) as unknown as typeof process.exit);
    return { dm, order, exit };
  }
  const stopStepSource = () => {
    const source = readSourceText(__dirname, '../../src/bot/internalSetup/clientInitializer.ts');
    return source.slice(source.indexOf('addStopStep(async () => {'), source.indexOf('addReleaseStep(() => stopMainWatch());'));
  };

  it('run in order: begin, the final steps, the drain, release, exit', async () => {
    const { dm, order } = await freshStop();
    await stopSteps(dm, { claims: () => ({ beginStop: () => undefined, finishStop: async () => undefined }), order })();
    expect(order).toEqual(['beginStop', 'drain', 'finishStop', 'exit 0', 'exit']);
  });

  it('a release that throws still exits once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { dm, exit } = await freshStop();
    await stopSteps(dm, { claims: () => ({ beginStop: () => undefined, finishStop: async () => { throw new Error('boom'); } }) })();
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("clientInitializer's stop step cuts a gateway close at 2 s, so the drain still runs", () => {
    const step = stopStepSource();
    expect(step).toContain("getIngestService().close('shutting down')");
    expect(step).toContain('new Promise(resolve => setTimeout(resolve, 2000))');
  });

  it('a stop step that throws is logged and the release and the exit still run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { dm, order } = await freshStop();
    const failure = new Error('boom');
    const stop = stopSteps(dm, { claims: () => ({ beginStop: () => undefined, finishStop: async () => undefined }), order });
    dm.addStopStep(() => { throw failure; });
    await stop();
    expect(error.mock.calls).toContainEqual(['[Data] A stop step failed:', failure]);
    expect(order.slice(-3)).toEqual(['finishStop', 'exit 0', 'exit']);
  });
});
