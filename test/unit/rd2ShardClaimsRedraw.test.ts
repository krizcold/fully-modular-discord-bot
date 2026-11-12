import { describe, expect, it } from 'vitest';

import type { ClaimTimings, Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { ClaimStoreApi, RedrawAnswer, RenewAnswer, StandbyTakeAnswer } from '../../src/bot/internalSetup/fleet/claimStore';
import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';

const ME = { processId: 'p-rd2', nodeId: 'n-rd2', nodeName: 'R' };
const TIMINGS: ClaimTimings = { ttlMs: 30_000, renewMs: 2, deadlineMs: 100, statementMs: 1_000, lockMs: 500 };
const P0: Pair = { shardCount: 4, shardId: 0, claim: 7 };
const P1: Pair = { shardCount: 4, shardId: 1, claim: 8 };
const TAKEN = { count: 4, processId: ME.processId, pairs: [P0, P1] };

type RedrawStep = (onBegin: () => void, rig: Rig) => Promise<RedrawAnswer>;
type RenewStep = (pairs: Pair[], rig: Rig) => RenewAnswer;

interface Rig {
  claims: ShardClaims;
  clock: { now: number };
  stopping: { on: boolean };
  redraws: number;
  renews: Array<{ pairs: Pair[]; targetEdge: boolean }>;
  releases: number;
  standbyTakes: number;
  lapsed: number[];
  lines: string[];
}

function done(pairs: Pair[]): RedrawAnswer {
  return { kind: 'done', pairs, closed: null };
}

function renewAll(pairs: Pair[], rig: Rig): RenewAnswer {
  return { rows: pairs.map(p => ({ ...p, mine: true, released: false })), at: rig.clock.now, priorProcess: ME.processId };
}

function build(opts: {
  redraw?: RedrawStep[];
  renew?: RenewStep;
  standby?: boolean;
  noStandbyTake?: boolean;
} = {}): Rig {
  const redrawSteps = [...(opts.redraw ?? [])];
  const renewStep = opts.renew ?? renewAll;
  const lines: string[] = [];
  const put = (...a: unknown[]) => { lines.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' ')); };
  const rig = {
    clock: { now: 1_000 }, stopping: { on: false }, redraws: 0, renews: [], releases: 0, standbyTakes: 0, lapsed: [], lines,
  } as unknown as Rig;
  const store: Partial<ClaimStoreApi> = {
    async renew(request) {
      rig.renews.push({ pairs: [...request.pairs], targetEdge: request.heartbeat.targetEdge === true });
      return renewStep(request.pairs, rig);
    },
    async redraw(_request, onBegin) {
      rig.redraws += 1;
      const step = redrawSteps.shift();
      if (!step) throw new Error('no redraw answer left');
      return step(() => onBegin?.(), rig);
    },
    async release() {
      rig.releases += 1;
      return [];
    },
    pause() {},
    resume() {},
    abandonWork() {},
    abandonRenewal() {},
    async end() {},
  };
  if (!opts.noStandbyTake) {
    store.standbyTake = async (): Promise<StandbyTakeAnswer> => {
      rig.standbyTakes += 1;
      return { kind: 'not-standby', attempt: null, state: null, reason: null };
    };
  }
  const deps: ShardClaimsDeps = {
    store: store as ClaimStoreApi, me: ME, timings: TIMINGS, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true,
    startedAt: 0, clocks: () => ({ perf: rig.clock.now, wall: rig.clock.now }), fitness: () => null, gateClosed: () => false,
    isStopping: () => rig.stopping.on, stopServingStep: () => undefined, noteLapsed: seconds => { rig.lapsed.push(seconds); },
    noteLost: () => undefined, restartForShards: () => true, countSetting: () => null, reshardOverlap: () => true,
    log: { log: put, warn: put, error: put },
    ...(opts.standby ? { standby: { attempt: 'a-rd2', count: 4, onEnd: () => undefined } } : {}),
  };
  rig.claims = new ShardClaims(deps);
  return rig;
}

const answerAt = (pairs: Pair[], advance = 0): RedrawStep => async (onBegin, rig) => {
  onBegin();
  rig.clock.now += advance;
  return done(pairs);
};

const failAt = (advance: number, beforeBegin = 0): RedrawStep => async (onBegin, rig) => {
  rig.clock.now += beforeBegin;
  onBegin();
  rig.clock.now += advance;
  throw new Error('connection terminated unexpectedly');
};

describe('rd2 the redraw sends nothing once a stop began or the database stopped', () => {
  it('a stop that began first: no redraw statement and no answer', async () => {
    const rig = build({ redraw: [answerAt([P0, P1])] });
    rig.stopping.on = true;
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.redraws).toBe(0);
    expect(rig.claims.heldPairs()).toEqual([]);
  });

  it('a database stop that came first: no redraw statement and no answer', async () => {
    const rig = build({ redraw: [answerAt([P0, P1])] });
    rig.claims.stopServingForDatabase('the move began');
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.redraws).toBe(0);
    expect(rig.claims.heldPairs()).toEqual([]);
  });
});

describe('rd2 a redraw counts as a take for the release at the stop', () => {
  it('the stop after a redraw sends the release', async () => {
    const rig = build({ redraw: [answerAt([P0, P1])] });
    const answer = await rig.claims.redraw(TAKEN);
    expect(answer?.pairs).toEqual([P0, P1]);
    await rig.claims.finishStop();
    expect(rig.releases).toBe(1);
  });

  it('a stop with no take and no redraw sends no release', async () => {
    const rig = build();
    await rig.claims.finishStop();
    expect(rig.releases).toBe(0);
  });
});

describe('rd2 the redraw answer acknowledged after the deadline is renewed before it is served', () => {
  it('an answer in time is served as returned, with no renewal', async () => {
    const rig = build({ redraw: [answerAt([P0, P1], 10)], renew: (_pairs, r) => renewAll([], r) });
    const answer = await rig.claims.redraw(TAKEN);
    expect(answer).toEqual({ shardCount: 4, pairs: [P0, P1], lost: [] });
    expect(rig.renews).toEqual([]);
    expect(rig.claims.heldPairs()).toEqual([P0, P1]);
  });

  it('an answer exactly D after its BEGIN is renewed, and only the pairs the renewal returned are served', async () => {
    const rig = build({ redraw: [answerAt([P0, P1], TIMINGS.deadlineMs)], renew: (_pairs, r) => renewAll([P0], r) });
    const answer = await rig.claims.redraw(TAKEN);
    expect(rig.renews.map(r => r.pairs)).toEqual([[P0, P1]]);
    expect(answer).toEqual({ shardCount: 4, pairs: [P0], lost: [] });
    expect(rig.claims.heldPairs()).toEqual([P0]);
  });

  it('the late answer is measured from the BEGIN, not from when the answer arrived', async () => {
    const step: RedrawStep = async (onBegin, r) => {
      onBegin();
      r.clock.now += TIMINGS.deadlineMs + 5;
      return done([P0, P1]);
    };
    const rig = build({ redraw: [step], renew: (_pairs, r) => renewAll([P1], r) });
    const answer = await rig.claims.redraw(TAKEN);
    expect(rig.renews).toHaveLength(1);
    expect(answer?.pairs).toEqual([P1]);
  });

  it('a late answer with no pair returned sends no renewal', async () => {
    const rig = build({ redraw: [answerAt([], TIMINGS.deadlineMs + 5)] });
    const answer = await rig.claims.redraw(TAKEN);
    expect(answer).toEqual({ shardCount: 4, pairs: [], lost: [P0, P1] });
    expect(rig.renews).toEqual([]);
  });

  it('a database stop during the late renewal answers null', async () => {
    const rig = build({
      redraw: [answerAt([P0, P1], TIMINGS.deadlineMs)],
      renew: (pairs, r) => { r.claims.stopServingForDatabase('the move began'); return renewAll(pairs, r); },
    });
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.renews).toHaveLength(1);
  });

  it("the late renewal clears the heartbeat's first-statement edge for the next renewal", async () => {
    const rig = build({ redraw: [answerAt([P0, P1], TIMINGS.deadlineMs)] });
    await rig.claims.redraw(TAKEN);
    await rig.claims.renewOnce();
    await rig.claims.finishStop();
    expect(rig.renews.map(r => r.targetEdge)).toEqual([true, false]);
  });
});

describe('rd2 a stop or a database stop during the redraw answers null', () => {
  it('a stop that began while the redraw was on the wire', async () => {
    const step: RedrawStep = async (onBegin, r) => { onBegin(); r.stopping.on = true; return done([P0, P1]); };
    const rig = build({ redraw: [step] });
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.renews).toEqual([]);
  });

  it('a database stop while the redraw was on the wire', async () => {
    const step: RedrawStep = async (onBegin, r) => { onBegin(); r.claims.stopServingForDatabase('the move began'); return done([P0, P1]); };
    const rig = build({ redraw: [step] });
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
  });
});

describe('rd2 a failed redraw statement', () => {
  it('the lanes stopped while it failed: null at once, no retry', async () => {
    const step: RedrawStep = async (onBegin, r) => {
      onBegin();
      void r.claims.stopLanes();
      throw new Error('connection terminated unexpectedly');
    };
    const rig = build({ redraw: [step, answerAt([P0, P1])] });
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.redraws).toBe(1);
  });

  it('a database stop while it failed: null, and the failure is not recorded as the renewal error', async () => {
    const step: RedrawStep = async (onBegin, r) => {
      onBegin();
      r.claims.stopServingForDatabase('the move began');
      throw new Error('connection terminated unexpectedly');
    };
    const rig = build({ redraw: [step, answerAt([P0, P1])] });
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.redraws).toBe(1);
    expect(rig.claims.latestFailureClass()).toBeNull();
  });

  it('exactly D after the first BEGIN: the lapse runs and the redraw answers null', async () => {
    const rig = build({ redraw: [failAt(TIMINGS.deadlineMs), answerAt([P0, P1])] });
    expect(await rig.claims.redraw(TAKEN)).toBeNull();
    expect(rig.redraws).toBe(1);
    expect(rig.lapsed).toEqual([0]);
    expect(rig.claims.snapshot().stopped).toBe('lapse');
  });

  it('D is counted from the first BEGIN, not from the call', async () => {
    const rig = build({ redraw: [failAt(0, 60), failAt(50), answerAt([P0, P1])] });
    const answer = await rig.claims.redraw(TAKEN);
    expect(answer).toEqual({ shardCount: 4, pairs: [P0, P1], lost: [] });
    expect(rig.redraws).toBe(3);
    expect(rig.lapsed).toEqual([]);
  });
});

describe('rd2 the standby take', () => {
  it('outside standby mode it is a build error that says so', async () => {
    const rig = build();
    await expect(rig.claims.standbyTake()).rejects.toThrow('standbyTake() outside standby mode');
  });

  it('a store with no standby take is a build error that says so', async () => {
    const rig = build({ standby: true, noStandbyTake: true });
    await expect(rig.claims.standbyTake()).rejects.toThrow('this claims store has no standby take');
  });

  it('a stop that began first: no take is sent', async () => {
    const rig = build({ standby: true });
    rig.stopping.on = true;
    expect(await rig.claims.standbyTake()).toBeNull();
    expect(rig.standbyTakes).toBe(0);
  });
});
