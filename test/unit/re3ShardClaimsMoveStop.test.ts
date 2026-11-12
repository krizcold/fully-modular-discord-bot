import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ShardClaims, closeLine, l16Line, releaseFailureLine, releaseLines, type ShardClaimsDeps,
} from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import {
  ClaimFailure, ClaimPausedError, type ClaimStoreApi, type PageRead, type RenewAnswer, type RetakeRequest, type TakeAnswer,
} from '../../src/bot/internalSetup/fleet/claimStore';

const T = claimTimings(30);
const ME = { processId: 'p-re3', nodeId: 'n-re3', nodeName: 'R' };
const TARGET = { address: 'db2:5432/bot', generation: 2 };

type Logged = { level: 'log' | 'warn' | 'error'; args: unknown[] };

function rig(storeOver: Partial<ClaimStoreApi> = {}, over: Partial<ShardClaimsDeps> = {}) {
  const calls = { pause: 0, resume: 0, abandonWork: 0, renew: 0, readPage: 0, take: 0, lost: [] as Pair[][], lapsed: 0, onPage: 0, restarts: [] as string[] };
  const store: ClaimStoreApi = {
    renew: async () => ({ rows: [], at: 1, priorProcess: null }),
    retake: async () => ({ taken: [] }),
    pause() { calls.pause += 1; },
    resume() { calls.resume += 1; },
    take: async () => { throw new Error('no take scripted'); },
    release: async () => [],
    readPage: async () => { throw new Error('no page scripted'); },
    readRow: async () => ({ row: null, storedCount: null }),
    abandonWork() { calls.abandonWork += 1; },
    abandonRenewal() { /* none on the wire */ },
    end: async () => undefined,
    ...storeOver,
  };
  const renew = store.renew.bind(store);
  store.renew = (request, opts) => { calls.renew += 1; return renew(request, opts); };
  const readPage = store.readPage.bind(store);
  store.readPage = count => { calls.readPage += 1; return readPage(count); };
  const take = store.take.bind(store);
  store.take = (request, onBegin) => { calls.take += 1; return take(request, onBegin); };
  const logged: Logged[] = [];
  const at = (level: Logged['level']) => (...args: unknown[]) => { logged.push({ level, args }); };
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => { calls.lapsed += 1; }, noteLost: lost => { calls.lost.push(lost); },
    restartForShards: reason => { calls.restarts.push(reason); return false; }, countSetting: () => null,
    reshardOverlap: () => true, log: { log: at('log'), warn: at('warn'), error: at('error') }, ...over,
  });
  const lines = (level?: Logged['level']) => logged.filter(l => !level || l.level === level).map(l => l.args.map(String).join(' '));
  return { claims, store, calls, logged, lines };
}

const anyClaims = (c: ShardClaims) => c as unknown as Record<string, any>;

async function drainWork(c: ShardClaims): Promise<void> {
  for (let i = 0; i < 20 && anyClaims(c).workRun; i++) await anyClaims(c).workRun;
  expect(anyClaims(c).workRun).toBeNull();
}

async function waitFor(cond: () => boolean, bound = 200): Promise<void> {
  for (let i = 0; i < bound && !cond(); i++) await new Promise<void>(resolve => { setImmediate(resolve); });
  expect(cond()).toBe(true);
}

function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), new Promise<boolean>(resolve => { setTimeout(() => resolve(false), ms); })]);
}

const page = (over: Partial<PageRead> = {}): PageRead => ({ shardCount: 2, upMs: 1000, uPrimeMs: 1000, rows: [], nodes: [], ...over });

const H0: Pair = { shardCount: 2, shardId: 0, claim: 7 };
const R1: Pair = { shardCount: 2, shardId: 1, claim: 8 };

afterEach(() => { vi.useRealTimers(); });

describe('re3 the move renewal and the reserved pairs it judges', () => {
  function withReserved(rows: RenewAnswer['rows']) {
    const r = rig({ renew: async () => ({ rows, at: 5, priorProcess: null }) });
    anyClaims(r.claims).held = [H0];
    anyClaims(r.claims).reserved = [{ ...R1, at: { perf: 0, wall: 0 } }];
    return r;
  }

  it('a reservation the move renewal returned released stays reserved and runs no loss', async () => {
    const r = withReserved([{ ...H0, mine: true, released: false }, { ...R1, mine: true, released: true }]);
    expect(await r.claims.moveClaims(TARGET)).toBe(true);
    expect(r.calls.lost).toEqual([]);
    expect(r.claims.snapshot().reserved).toEqual([R1]);
    expect(r.claims.snapshot().stopped).toBeNull();
  });

  it('a reservation the move renewal did not return is lost at the end of the move', async () => {
    const r = withReserved([{ ...H0, mine: true, released: false }]);
    expect(await r.claims.moveClaims(TARGET)).toBe(true);
    expect(r.calls.lost).toEqual([[R1]]);
    expect(r.claims.snapshot().reserved).toEqual([]);
    expect(r.claims.snapshot().stopped).toBe('loss');
  });

  it('a reservation returned unreleased is lost too', async () => {
    const r = withReserved([{ ...H0, mine: true, released: false }, { ...R1, mine: true, released: false }]);
    expect(await r.claims.moveClaims(TARGET)).toBe(true);
    expect(r.calls.lost).toEqual([[R1]]);
  });

  it('a renewal asked while the move renewal is on the wire settles once it answers', async () => {
    let answer: (a: RenewAnswer) => void = () => undefined;
    const r = rig({ renew: () => new Promise<RenewAnswer>(resolve => { answer = resolve; }) });
    anyClaims(r.claims).held = [H0];
    const move = r.claims.moveClaims(TARGET);
    const waiting = r.claims.renewOnce();
    answer({ rows: [{ ...H0, mine: true, released: false }], at: 5, priorProcess: null });
    expect(await move).toBe(true);
    expect(await settledWithin(waiting, 500)).toBe(true);
    expect(r.calls.renew).toBe(1);
  });
});

describe('re3 the re-take names the guilds of each missing shard', () => {
  function missingRig(over: Partial<ShardClaimsDeps>) {
    const asked: RetakeRequest[] = [];
    const r = rig({
      renew: async () => ({ rows: [], at: 5, priorProcess: null }),
      retake: async request => { asked.push(request); return { taken: [{ before: request.pairs[0], pair: { ...request.pairs[0], claim: 9 } }] }; },
    }, over);
    anyClaims(r.claims).held = [H0];
    return { ...r, asked };
  }

  it('sends the guilds the working set holds for the shard', async () => {
    const r = missingRig({ guildsOfShard: id => (id === 0 ? ['g-1', 'g-2'] : []) });
    expect(await r.claims.moveClaims(TARGET)).toBe(true);
    expect(r.asked.map(a => a.guildIds)).toEqual([[{ shardId: 0, guildIds: ['g-1', 'g-2'] }]]);
    expect(r.claims.heldPairs()).toEqual([{ ...H0, claim: 9 }]);
  });

  it('sends an empty guild list when no guild source is wired', async () => {
    const r = missingRig({});
    expect(await r.claims.moveClaims(TARGET)).toBe(true);
    expect(r.asked.map(a => a.guildIds)).toEqual([[{ shardId: 0, guildIds: [] }]]);
  });
});

describe('re3 an attempt that ended after the move', () => {
  it('pauses the store once when the lanes are already paused', () => {
    const r = rig();
    r.claims.stopServingForDatabase('db1 was replaced');
    expect(r.calls.pause).toBe(1);
    r.claims.moveAttemptEnded();
    expect(r.calls.pause).toBe(1);
  });

  it('pauses the renewal lane again after the move resumed it', async () => {
    const r = rig({ renew: async () => ({ rows: [{ ...H0, mine: true, released: false }], at: 5, priorProcess: null }) });
    anyClaims(r.claims).held = [H0];
    expect(await r.claims.moveClaims(TARGET)).toBe(true);
    expect(r.calls.resume).toBe(1);
    const before = r.calls.renew;
    r.claims.moveAttemptEnded();
    expect(r.calls.pause).toBe(1);
    await r.claims.renewOnce();
    expect(r.calls.renew).toBe(before);
  });
});

describe('re3 the claim a move took again', () => {
  it('starts the deadline of the new claim from the re-take', () => {
    let now = { perf: 0, wall: 0 };
    const r = rig({}, { clocks: () => ({ ...now }) });
    anyClaims(r.claims).held = [H0];
    r.claims.replaceClaim(H0, 9);
    expect(r.claims.heldPairs()).toEqual([{ ...H0, claim: 9 }]);
    now = { perf: T.deadlineMs - 1, wall: T.deadlineMs - 1 };
    expect(r.claims.stoppedServing()).toBe(false);
    now = { perf: T.deadlineMs + 1, wall: T.deadlineMs + 1 };
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.calls.lapsed).toBe(1);
  });

  it('logs a fence that could not take the new claim', () => {
    const boom = new Error('fence closed');
    const r = rig({}, { replaceShardClaim: () => { throw boom; } });
    anyClaims(r.claims).held = [H0];
    r.claims.replaceClaim(H0, 9);
    expect(r.logged).toEqual([{ level: 'error', args: ['[Shards] Could not put the new claim in the fence:', boom] }]);
  });

  it('names no cause when the move renewal met the pause before any latch', async () => {
    const r = rig({ renew: async () => { throw new ClaimPausedError(); } });
    anyClaims(r.claims).held = [H0];
    expect(await r.claims.moveClaims(TARGET)).toBe(false);
    expect(r.lines('error')).toEqual([
      '[Database] Not moving to db2:5432/bot yet: the claim renewal there failed (the move stopped while it waited: no cause recorded); this process keeps its unsaved changes and stays stopped',
    ]);
  });
});

describe('re3 the work lane', () => {
  it('a page read the pause dropped records no page read error', async () => {
    const r = rig({ readPage: async () => { throw new ClaimPausedError(); } });
    r.claims.noteGranted();
    await r.claims.renewOnce();
    await drainWork(r.claims);
    expect(r.calls.readPage).toBe(1);
    expect(r.claims.snapshot().pageReadError).toBeNull();
  });

  it('hands the page to the reshard driver only outside a stop', async () => {
    const r = rig({ readPage: async () => page() }, { onPage: () => { r.calls.onPage += 1; } });
    r.claims.noteGranted();
    await r.claims.renewOnce();
    await drainWork(r.claims);
    expect(r.calls.onPage).toBe(1);
    r.claims.beginStop();
    await r.claims.renewOnce();
    await drainWork(r.claims);
    expect(r.calls.readPage).toBe(2);
    expect(r.calls.onPage).toBe(1);
  });

  it('hands no page to the reshard driver once the process is stopping', async () => {
    let stopping = false;
    const r = rig({ readPage: async () => page() }, { onPage: () => { r.calls.onPage += 1; }, isStopping: () => stopping });
    r.claims.noteGranted();
    stopping = true;
    await r.claims.renewOnce();
    await drainWork(r.claims);
    expect(r.calls.readPage).toBe(1);
    expect(r.calls.onPage).toBe(0);
  });

  it('drops the planned returns while a reshard attempt is open', async () => {
    const open = page({ reshard: { attempt: 'a-1', state: 'standby', fromCount: 2, toCount: 4, metaCount: 2 } });
    const r = rig({ readPage: async () => open }, { returns: true });
    anyClaims(r.claims).shardCount = 2;
    anyClaims(r.claims).returnList = [{ shardId: 1, receiver: 'n-b', move: false }];
    expect(r.claims.snapshot().returning).toEqual([1]);
    r.claims.noteGranted();
    await r.claims.renewOnce();
    await drainWork(r.claims);
    expect(r.claims.snapshot().returning).toEqual([]);
    expect(r.calls.restarts).toEqual([]);
  });

  it("logs a running take's held line again after a take completed between two waits", async () => {
    const held: TakeAnswer = { kind: 'held', read: { attempt: null, state: null, fromCount: null, toCount: null, metaCount: 4 }, rows: [{ shardCount: 4, shardId: 3, holderName: 'B' }] };
    const done: TakeAnswer = {
      kind: 'done', shardCount: 2, taken: [], predecessorRenewedAt: new Map(),
      plan: { takes: [], wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: 0 },
    };
    const answers = [held, done, held];
    const r = rig({ readPage: async () => page(), take: async () => answers.shift()! });
    anyClaims(r.claims).shardCount = 2;
    r.claims.noteGranted();
    for (let i = 0; i < 3; i++) {
      await r.claims.renewOnce();
      await drainWork(r.claims);
    }
    expect(r.calls.take).toBe(3);
    const line = '[Shards] Not taking shards of the 2-shard set yet: shard(s) 3 of the 4-shard set are still held by B; trying again every 5 s';
    expect(r.lines('warn').filter(l => l === line)).toHaveLength(2);
  });
});

describe('re3 the release of serve lanes promoted from a standby', () => {
  it("names each shard once when a standby pair's shard is also held", async () => {
    const r = rig({ release: async () => { throw new ClaimFailure({ kind: 'refused' }); } }, {
      fromStandby: true, standbyPairs: [{ shardCount: 8, shardId: 0, claim: 70 }, { shardCount: 8, shardId: 1, claim: 71 }],
    });
    anyClaims(r.claims).held = [{ shardCount: 8, shardId: 0, claim: 5 }];
    await r.claims.finishStop();
    expect(r.lines('error')).toEqual([
      '[Shards] Could not release shards 0, 1 (the database refused the login); any machine with room may take them once their claims expire',
    ]);
  });

  it('runs the close after a hand-over on the work lane by its name', async () => {
    const names: string[] = [];
    const r = rig({
      release: async () => [{ shardId: 0, claim: 5, wasReserved: false, handedTo: null }],
      withWorkClient: async <T>(what: string): Promise<T> => { names.push(what); return { kind: 'not-closed' } as T; },
    }, { fromStandby: true });
    anyClaims(r.claims).held = [{ shardCount: 4, shardId: 0, claim: 5 }];
    r.claims.noteHandOver(4, 8);
    await r.claims.finishStop();
    expect(names).toEqual(['the close']);
  });

  it('destroys the close that got no answer in 2 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let destroyed = false;
    let fail: (e: Error) => void = () => undefined;
    const r = rig({
      release: async () => [{ shardId: 0, claim: 5, wasReserved: false, handedTo: null }],
      withWorkClient: <T>(): Promise<T> => new Promise<T>((_resolve, reject) => { fail = reject; }),
      abandonWork() { r.calls.abandonWork += 1; if (r.calls.abandonWork > 1) { destroyed = true; fail(new Error('connection destroyed')); } },
    }, { fromStandby: true });
    anyClaims(r.claims).held = [{ shardCount: 4, shardId: 0, claim: 5 }];
    r.claims.noteHandOver(4, 8);
    const stop = r.claims.finishStop();
    await waitFor(() => r.lines('log').some(l => l.startsWith('[Shards] Released the old shard(s) 0')));
    expect(r.calls.abandonWork).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await stop;
    expect(r.calls.abandonWork).toBe(2);
    expect(destroyed).toBe(true);
  });
});

describe('re3 the shard log lines', () => {
  it('names the old shards that expired instead of being released', () => {
    expect(closeLine(4, [3, 1])).toBe("[Shards] The 4 old shards are released or expired; each machine's new shards serve once its old bot process has stopped; shard(s) 1, 3 expired instead (their process stopped renewing before it released them)");
    expect(closeLine(4, [])).toBe("[Shards] The 4 old shards are released; each machine's new shards serve once its old bot process has stopped");
  });

  it('says unset for a removed setting that had no earlier value', () => {
    expect(l16Line(null, null)).toBe("[Shards] FLEET_SHARD_COUNT on this machine was removed (it was unset): the bot follows Discord's recommended count upward");
  });

  it('logs no hand-over line when the release kept no shard', () => {
    const rows = [{ shardId: 2, claim: 9, wasReserved: true, handedTo: null }, { shardId: 3, claim: 10, wasReserved: false, handedTo: 'B' }];
    expect(releaseLines([], [], rows, T.ttlMs, { from: 4, to: 8 })).toEqual([
      "[Shards] Reserved shards 2 stay kept for this machine's next start for 30 s, then free to any machine with room",
      '[Shards] Handed shard 3 to B',
    ]);
  });

  it('names a shard asked twice and not returned once', () => {
    const asked = [{ shardCount: 4, shardId: 1, claim: 5 }, { shardCount: 4, shardId: 1, claim: 6 }];
    expect(releaseLines(asked, [], [], T.ttlMs)).toEqual(['[Shards] Shard 1 was no longer held by this process at the release']);
  });

  it('a release error before COMMIT was sent is a plain failure, whatever its severity', () => {
    const failure = { kind: 'error' as const, code: '57P01', message: 'terminating connection', severity: 'FATAL' };
    expect(releaseFailureLine([H0], failure, false)).toBe('[Shards] Could not release shards 0 (SQLSTATE 57P01 terminating connection); any machine with room may take them once their claims expire');
  });
});
