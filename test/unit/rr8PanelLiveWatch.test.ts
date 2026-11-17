import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { LIVE_REASONS, PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';

type Have = { haveVersion: number; haveSince: number | null };
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Plan = { connect?: 'ok' | 'reject' | 'pending'; listen?: 'ok' | 'pending' };

class FakeListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: () => undefined } };
  readonly queries: string[] = [];
  ended = 0;
  readonly connectGate = deferred<void>();
  readonly listenGate = deferred<unknown>();
  constructor(readonly config: { host?: string }, private readonly plan: Plan) { super(); }
  connect(): Promise<unknown> {
    if (this.plan.connect === 'reject') return Promise.reject(new Error('connection refused'));
    if (this.plan.connect === 'pending') return this.connectGate.promise;
    return Promise.resolve();
  }
  query(text: string): Promise<unknown> {
    this.queries.push(text);
    if (text.startsWith('LISTEN') && this.plan.listen === 'pending') return this.listenGate.promise;
    return Promise.resolve({ rows: [] });
  }
  end(): Promise<unknown> { this.ended += 1; return Promise.resolve(); }
}

const LOCAL = 'postgres://bot@localhost/bot';
const LOCAL2 = 'postgres://bot@127.0.0.1/other';
const OPEN = 'postgres://bot@db.example.invalid/bot';
const REFUSED = { refusal: 'no database here' };

function makeRig(opts: { entry?: { entry: string } | { refusal: string }; auto?: FetchAnswer | null } = {}) {
  const script: (FetchAnswer | Error)[] = [];
  const pending: Deferred<FetchAnswer>[] = [];
  const asked: Have[] = [];
  const emitted: unknown[] = [];
  const statuses: { live: boolean; reason: string | null }[] = [];
  const clients: FakeListen[] = [];
  const plans: Plan[] = [];
  const state = { entry: opts.entry ?? REFUSED as { entry: string } | { refusal: string }, throwsLeft: 0, auto: opts.auto ?? null };
  const deps: WatchDeps = {
    fetch: (_g, _p, _u, have) => {
      asked.push(have);
      const next = script.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (next) return Promise.resolve(next);
      if (state.auto) return Promise.resolve(state.auto);
      const d = deferred<FetchAnswer>();
      pending.push(d);
      return d.promise;
    },
    emitUpdate: data => { emitted.push(data.response); return 1; },
    emitStatus: data => { statuses.push({ live: data.live, reason: data.reason }); },
    entry: () => state.entry,
    makeClient: config => {
      if (state.throwsLeft > 0) { state.throwsLeft -= 1; throw new Error('cannot build the client'); }
      const c = new FakeListen(config as { host?: string }, plans.shift() ?? {});
      clients.push(c);
      return c as any;
    },
  };
  return { w: new PanelLiveWatch(deps), script, pending, asked, emitted, statuses, clients, plans, state };
}

type Rig = ReturnType<typeof makeRig>;
let rig: Rig | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

async function fetchOnce(r: Rig, answer: FetchAnswer) {
  r.script.push(answer);
  const before = r.asked.length;
  r.w.watch('g', 'p', 'u', 'BRAVO');
  expect(r.asked.length).toBe(before + 1);
  await settle();
  expect(r.script.length).toBe(0);
}

const view = (marker: string) => ({ type: 'panel', marker });
const panelView = { embeds: [], components: [] };
const actionReply = (since: number, version: number) => ({ success: true, liveSince: since, liveVersion: version, data: panelView });
const liveAnswer: FetchAnswer = { status: 200, holderProcess: 'p1', reply: { success: true, since: 5, version: 1, notifying: true, servedBy: 'BRAVO', data: view('v1') } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  rig?.w.stop();
  rig = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rr8 which fetched answers raise the apply mark', () => {
  it('rr8 a new holder process with no state after a state of version 0 raises the mark and refuses an older action', async () => {
    rig = makeRig();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, notifying: true, data: view('v0') } });
    const mark = rig.w.applyMark();
    await fetchOnce(rig, { status: 200, holderProcess: 'p2', reply: { success: true, since: 1, notifying: true } });
    expect(rig.w.applyMark()).toBe(mark + 1);
    expect(rig.w.actionArrived('g', 'p', 'p2', actionReply(1, 1), mark)).toMatchObject({ sent: 0, refused: true });
  });

  it('rr8 a new since with no state after a state of version 0 raises the mark', async () => {
    rig = makeRig();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, notifying: true, data: view('v0') } });
    const mark = rig.w.applyMark();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 2, notifying: true } });
    expect(rig.w.applyMark()).toBe(mark + 1);
    expect(rig.w.actionArrived('g', 'p', 'p1', actionReply(2, 1), mark)).toMatchObject({ sent: 0, refused: true });
  });

  it('rr8 a state below the shown action view raises the mark although nothing is sent', async () => {
    rig = makeRig();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    expect(rig.w.actionArrived('g', 'p', 'p1', actionReply(1, 7)).sent).toBe(1);
    const mark = rig.w.applyMark();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true, data: view('v5') } });
    expect(rig.emitted).toEqual([view('v3'), panelView]);
    expect(rig.w.applyMark()).toBe(mark + 1);
  });

  it('rr8 the state at the shown action view version leaves the mark and an action sent then reaches the tabs', async () => {
    rig = makeRig();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    expect(rig.w.actionArrived('g', 'p', 'p1', actionReply(1, 7)).sent).toBe(1);
    const mark = rig.w.applyMark();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 7, notifying: true, data: view('v7') } });
    expect(rig.w.applyMark()).toBe(mark);
    expect(rig.w.actionArrived('g', 'p', 'p1', actionReply(1, 8), mark)).toMatchObject({ sent: 1, refused: false });
  });

  it('rr8 an answer with no state and no change leaves the mark', async () => {
    rig = makeRig();
    const mark = rig.w.applyMark();
    await fetchOnce(rig, { status: 200, reply: { success: true, notifying: true } });
    expect(rig.w.applyMark()).toBe(mark);
    expect(rig.w.actionArrived('g', 'p', undefined, actionReply(7, 1), mark)).toMatchObject({ sent: 1, refused: false });
  });
});

describe('rr8 a refetch asked while a fetch runs', () => {
  it('rr8 a fetch sent before the refetch keeps the resend, so the next fetch asks for the whole state', async () => {
    rig = makeRig();
    const mark = rig.w.applyMark();
    await fetchOnce(rig, { status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    expect(rig.pending.length).toBe(1);
    expect(rig.w.actionArrived('g', 'p', 'p1', actionReply(1, 4), mark)).toMatchObject({ sent: 0, refused: true });
    rig.script.push({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3 again') } });
    rig.pending.shift()!.resolve({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true } });
    await settle();
    expect(rig.asked).toHaveLength(3);
    expect(rig.asked[2]).toEqual({ haveVersion: 0, haveSince: null });
    expect(rig.emitted.at(-1)).toEqual(view('v3 again'));
  });
});

describe('rr8 the warning of a failed fetch', () => {
  it('rr8 a failure exactly 60 s after the last warning is logged again, one earlier is not', async () => {
    rig = makeRig();
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    rig.script.push(new Error('boom'));
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    rig.script.push(new Error('boom'));
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    rig.script.push(new Error('boom'));
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe('[PanelLive] Could not fetch the new state of panel p of server g from BRAVO (boom)');
  });
});

describe('rr8 the listener when the database has no address', () => {
  it('rr8 a watch with no database says the database cannot be reached, at once and to the page', () => {
    rig = makeRig();
    const status = rig.w.watch('g', 'p', 'u', 'BRAVO');
    expect(status).toEqual({ live: false, reason: LIVE_REASONS.unreachable });
    expect(rig.statuses).toEqual([{ live: false, reason: LIVE_REASONS.unreachable }]);
  });

  it('rr8 the listener connects 5 s later once the database has an address', async () => {
    rig = makeRig();
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    rig.state.entry = { entry: LOCAL };
    rig.state.auto = liveAnswer;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(rig.clients).toHaveLength(1);
    expect(rig.w.listenerUp()).toBe(true);
  });
});

describe('rr8 the listener when its client cannot be built', () => {
  it('rr8 the watch says the database cannot be reached, at once and to the page', () => {
    rig = makeRig({ entry: { entry: LOCAL } });
    rig.state.throwsLeft = 1;
    const status = rig.w.watch('g', 'p', 'u', 'BRAVO');
    expect(status).toEqual({ live: false, reason: LIVE_REASONS.unreachable });
    expect(rig.statuses).toEqual([{ live: false, reason: LIVE_REASONS.unreachable }]);
  });

  it('rr8 a new client is built 5 s later', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    rig.state.throwsLeft = 1;
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(rig.clients).toHaveLength(1);
    expect(rig.w.listenerUp()).toBe(true);
  });
});

async function listening(r: Rig) {
  r.w.watch('g', 'p', 'u', 'BRAVO');
  await settle();
  expect(r.w.listenerUp()).toBe(true);
  expect(r.statuses.at(-1)).toEqual({ live: true, reason: null });
}

describe('rr8 the listening connection and a changed address', () => {
  it('rr8 a watch after the address changed closes the old connection and opens one to the new address', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    await listening(rig);
    rig.state.entry = { entry: LOCAL2 };
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients).toHaveLength(2);
    expect(rig.clients[0].ended).toBe(1);
    expect(rig.clients[1].config.host).toBe('127.0.0.1');
    expect(rig.w.listenerUp()).toBe(true);
  });

  it('rr8 the end of the old connection after the change does not stop the new one', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    await listening(rig);
    rig.state.entry = { entry: LOCAL2 };
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients).toHaveLength(2);
    rig.clients[0].emit('end');
    await settle();
    expect(rig.w.listenerUp()).toBe(true);
    expect(rig.clients[1].ended).toBe(0);
    expect(rig.statuses.at(-1)).toEqual({ live: true, reason: null });
  });

  it('rr8 while the new connection connects the page reads that the web panel is still connecting', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    await listening(rig);
    rig.state.entry = { entry: LOCAL2 };
    rig.plans.push({ connect: 'pending' });
    const status = rig.w.watch('g', 'p', 'u', 'BRAVO');
    expect(status).toEqual({ live: false, reason: LIVE_REASONS.connecting });
  });

  it('rr8 an address change found by the check after every watch ended opens no connection', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    await listening(rig);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(rig.w.count()).toBe(0);
    rig.state.entry = { entry: LOCAL2 };
    await vi.advanceTimersByTimeAsync(25_000);
    await settle();
    expect(rig.clients).toHaveLength(1);
    expect(rig.clients[0].ended).toBe(1);
    expect(rig.w.listenerUp()).toBe(false);
  });

  it('rr8 an old connection that connects after the change does not touch the new one', async () => {
    rig = makeRig({ entry: { entry: OPEN }, auto: liveAnswer });
    rig.plans.push({ connect: 'pending' });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    rig.state.entry = { entry: LOCAL };
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.w.listenerUp()).toBe(true);
    rig.clients[0].connectGate.resolve();
    await settle();
    expect(rig.w.listenerUp()).toBe(true);
    expect(rig.clients[1].ended).toBe(0);
    expect(rig.statuses.at(-1)).toEqual({ live: true, reason: null });
  });

  it('rr8 an old connection whose LISTEN answers after the change does not mark the listener up', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    rig.plans.push({ listen: 'pending' }, { connect: 'pending' });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients[0].queries).toEqual(['LISTEN smdb_panel_changed']);
    rig.state.entry = { entry: LOCAL2 };
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients).toHaveLength(2);
    rig.clients[0].listenGate.resolve({ rows: [] });
    await settle();
    expect(rig.w.listenerUp()).toBe(false);
    expect(rig.statuses.at(-1)?.live).toBe(false);
  });
});

describe('rr8 a listening connection that ends or fails', () => {
  it('rr8 the end of the listening connection says the database cannot be reached', async () => {
    rig = makeRig({ entry: { entry: LOCAL }, auto: liveAnswer });
    await listening(rig);
    rig.clients[0].emit('end');
    await settle();
    expect(rig.w.listenerUp()).toBe(false);
    expect(rig.statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.unreachable });
  });

  it('rr8 a refused connect says the database cannot be reached and never marks the listener up', async () => {
    rig = makeRig({ entry: { entry: LOCAL } });
    rig.plans.push({ connect: 'reject' });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.w.listenerUp()).toBe(false);
    expect(rig.statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.unreachable });
  });

  it('rr8 a refused connect is tried again 5 s later', async () => {
    rig = makeRig({ entry: { entry: LOCAL } });
    rig.plans.push({ connect: 'reject' });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients).toHaveLength(1);
    rig.state.auto = liveAnswer;
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(rig.clients).toHaveLength(2);
    expect(rig.w.listenerUp()).toBe(true);
  });
});

describe('rr8 a connection that does not check the certificate', () => {
  it('rr8 it is closed and the page reads why', async () => {
    rig = makeRig({ entry: { entry: OPEN } });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.pending.length).toBe(1);
    expect(rig.clients).toHaveLength(1);
    expect(rig.clients[0].ended).toBe(1);
    expect(rig.clients[0].queries).toEqual([]);
    expect(rig.statuses).toEqual([{ live: false, reason: LIVE_REASONS.insecure }]);
  });

  it('rr8 it is tried again 5 s later', async () => {
    rig = makeRig({ entry: { entry: OPEN } });
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    expect(rig.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(rig.clients).toHaveLength(2);
    expect(rig.clients[1].ended).toBe(1);
  });
});
