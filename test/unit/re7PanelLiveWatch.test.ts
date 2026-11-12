import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { LIVE_REASONS, PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';

const G = 'guild-1';

class FakeListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  constructor(readonly config: unknown) { super(); }
  connect() { return Promise.resolve(); }
  query() { return Promise.resolve({ rows: [] }); }
  end() { return Promise.resolve(); }
}

type Have = { haveVersion: number; haveSince: number | null };

function makeRig() {
  const pending: { have: Have; done: (a: FetchAnswer) => void }[] = [];
  const asked: Have[] = [];
  const updates: { response: unknown; servedBy: string }[] = [];
  const statuses: { live: boolean; reason: string | null }[] = [];
  const deps: WatchDeps = {
    fetch: (_g, _p, _u, have) => new Promise(done => { asked.push(have); pending.push({ have, done }); }),
    emitUpdate: data => { updates.push({ response: data.response, servedBy: data.servedBy }); return 1; },
    emitStatus: data => { statuses.push({ live: data.live, reason: data.reason }); },
    entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
    makeClient: config => new FakeListen(config) as any,
  };
  return { w: new PanelLiveWatch(deps), pending, asked, updates, statuses };
}

type Rig = ReturnType<typeof makeRig>;
let rig: Rig;

const settle = () => vi.advanceTimersByTimeAsync(0);
const answer = (): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, data: { content: 'Kept state' }, since: 5, version: 3, notifying: true, servedBy: 'BRAVO' } });

async function drain(r: Rig) {
  await settle();
  for (let i = 0; i < 10 && r.pending.length; i++) { r.pending.shift()!.done(answer()); await settle(); }
  expect(r.pending.length).toBe(0);
}

/** A live watched pair of holder p-b, since 5: its tabs were sent version 3 and the web UI has version 3. */
async function livePair(r: Rig) {
  r.w.watch(G, 'p', 'owner', 'BRAVO');
  await drain(r);
  expect(r.updates.length).toBe(1);
  expect(r.statuses.at(-1)).toEqual({ live: true, reason: null });
}

/** As livePair, then a page's answer raised the web UI's version to 5 while the tabs were sent version 3. */
async function aheadPair(r: Rig) {
  await livePair(r);
  r.w.noteAnswer(G, 'p', 'p-b', 5, 5);
  await settle();
  expect(r.pending.length).toBe(0);
}

const view = (over: Record<string, unknown>) => ({ success: true, data: { content: 'Action view' }, liveSince: 5, liveVersion: 4, servedBy: 'BRAVO', ...over });

beforeEach(() => {
  vi.useFakeTimers();
  rig = makeRig();
});
afterEach(() => {
  rig.w.stop();
  vi.useRealTimers();
});

describe('re7 actionArrived: which owner action views reach the tabs', () => {
  it('re7 an action view from another holder process reaches the tabs although its version is below the kept one', async () => {
    await aheadPair(rig);
    const before = rig.updates.length;
    expect(rig.w.shareActionView(G, 'p', 'p-c', view({ liveVersion: 4 }))).toBe(1);
    expect(rig.updates.length).toBe(before + 1);
    expect(rig.updates.at(-1)!.response).toEqual({ content: 'Action view' });
  });

  it('re7 an action view under another liveSince reaches the tabs although its version is below the kept one', async () => {
    await aheadPair(rig);
    const before = rig.updates.length;
    expect(rig.w.shareActionView(G, 'p', 'p-b', view({ liveSince: 9, liveVersion: 4 }))).toBe(1);
    expect(rig.updates.length).toBe(before + 1);
  });

  it('re7 an action view of the same holder and since at or below the kept version goes to no tab', async () => {
    await aheadPair(rig);
    const before = rig.updates.length;
    expect(rig.w.shareActionView(G, 'p', 'p-b', view({ liveVersion: 4 }))).toBe(0);
    expect(rig.w.shareActionView(G, 'p', 'p-b', view({ liveVersion: 5 }))).toBe(0);
    expect(rig.updates.length).toBe(before);
  });

  it('re7 an action view names the machine its answer named, else the pair name', async () => {
    await livePair(rig);
    rig.w.shareActionView(G, 'p', 'p-b', view({ liveVersion: 4, servedBy: 'CHARLIE' }));
    expect(rig.updates.at(-1)!.servedBy).toBe('CHARLIE');
    rig.w.shareActionView(G, 'p', 'p-b', view({ liveVersion: 5, servedBy: undefined }));
    expect(rig.updates.at(-1)!.servedBy).toBe('BRAVO');
  });
});

describe('re7 noteAnswer with an arrival: when the answer is set aside and the pair fetched again', () => {
  it('re7 an answer of the same holder and since after a later apply is kept, with no refetch', async () => {
    await livePair(rig);
    const asked = rig.asked.length;
    rig.w.noteAnswer(G, 'p', 'p-b', 5, 3, { sent: 1, refused: false, arrivedAt: 0 });
    await settle();
    expect(rig.asked.length).toBe(asked);
    expect(rig.statuses.at(-1)).toEqual({ live: true, reason: null });
  });

  it('re7 an answer of another holder process after a later apply refetches the whole state for every tab', async () => {
    await livePair(rig);
    const asked = rig.asked.length;
    rig.w.noteAnswer(G, 'p', 'p-c', 5, 3, { sent: 1, refused: false, arrivedAt: 0 });
    await settle();
    expect(rig.asked.length).toBe(asked + 1);
    expect(rig.asked.at(-1)).toEqual({ haveVersion: 0, haveSince: null });
    expect(rig.statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.updating });
  });

  it('re7 an answer under another since after a later apply refetches the whole state for every tab', async () => {
    await livePair(rig);
    const asked = rig.asked.length;
    rig.w.noteAnswer(G, 'p', 'p-b', 9, 3, { sent: 1, refused: false, arrivedAt: 0 });
    await settle();
    expect(rig.asked.length).toBe(asked + 1);
    expect(rig.asked.at(-1)).toEqual({ haveVersion: 0, haveSince: null });
    expect(rig.statuses.at(-1)).toEqual({ live: false, reason: LIVE_REASONS.updating });
  });

  it('re7 an answer of another holder and since with no later apply is adopted as the pair state', async () => {
    await livePair(rig);
    rig.w.noteAnswer(G, 'p', 'p-c', 9, 2, { sent: 1, refused: false, arrivedAt: rig.w.applyMark() });
    await settle();
    const asked = rig.asked.length;
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    expect(rig.asked.length).toBe(asked + 1);
    expect(rig.asked.at(-1)).toEqual({ haveVersion: 2, haveSince: 9 });
  });
});

describe('re7 noteAnswer: a page behind the other tabs is fetched again', () => {
  it('re7 a page answer below the kept version of the same holder and since fetches the pair', async () => {
    await aheadPair(rig);
    const asked = rig.asked.length;
    rig.w.noteAnswer(G, 'p', 'p-b', 5, 4);
    await settle();
    expect(rig.asked.length).toBe(asked + 1);
    expect(rig.asked.at(-1)).toEqual({ haveVersion: 4, haveSince: 5 });
  });

  it('re7 a page answer of another holder process at a lower version fetches nothing', async () => {
    await livePair(rig);
    const asked = rig.asked.length;
    rig.w.noteAnswer(G, 'p', 'p-c', 5, 2);
    await settle();
    expect(rig.asked.length).toBe(asked);
    expect(rig.pending.length).toBe(0);
  });
});
