import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { LIVE_REASONS, PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';

const G = 'guild-1';

class FakeListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  readonly end = vi.fn(() => Promise.resolve());
  constructor(readonly config: unknown) { super(); }
  connect() { return Promise.resolve(); }
  query() { return Promise.resolve({ rows: [] }); }
}

type Have = { haveVersion: number; haveSince: number | null };
type Status = { panelId: string; live: boolean; reason: string | null };

function makeRig() {
  const pending: { panelId: string; have: Have; done: (a: FetchAnswer) => void }[] = [];
  const asked: { panelId: string; have: Have }[] = [];
  const updates: { panelId: string; response: unknown }[] = [];
  const statuses: Status[] = [];
  const clients: FakeListen[] = [];
  const deps: WatchDeps = {
    fetch: (_g, panelId, _u, have) => new Promise(done => { asked.push({ panelId, have }); pending.push({ panelId, have, done }); }),
    emitUpdate: data => { updates.push({ panelId: data.panelId, response: data.response }); return 1; },
    emitStatus: data => { statuses.push({ panelId: data.panelId, live: data.live, reason: data.reason }); },
    entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
    makeClient: config => { const c = new FakeListen(config); clients.push(c); return c as any; },
  };
  return { w: new PanelLiveWatch(deps), pending, asked, updates, statuses, clients };
}

type Rig = ReturnType<typeof makeRig>;
let rig: Rig;

const settle = () => vi.advanceTimersByTimeAsync(0);
const answerOf = (version: number, content = 'Kept state'): FetchAnswer => ({
  status: null, holderProcess: 'p-b', reply: { success: true, data: { content }, since: 5, version, notifying: true, servedBy: 'BRAVO' },
});

async function drain(r: Rig, answer: () => FetchAnswer = () => answerOf(3)) {
  await settle();
  for (let i = 0; i < 10 && r.pending.length; i++) { r.pending.shift()!.done(answer()); await settle(); }
  expect(r.pending.length).toBe(0);
}

const statusesOf = (r: Rig, panelId: string) => r.statuses.filter(s => s.panelId === panelId).map(({ live, reason }) => ({ live, reason }));

/** A live watched pair of holder p-b, since 5: its tabs were sent version 3 and the web UI has version 3. */
async function livePair(r: Rig, panelId = 'p') {
  r.w.watch(G, panelId, 'owner', 'BRAVO');
  await drain(r);
  expect(statusesOf(r, panelId).at(-1)).toEqual({ live: true, reason: null });
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

describe('rf5 noteAnswer: which page answers lower the shown state and fetch again', () => {
  it('rf5 a page answer of the same holder under another since below the kept version fetches nothing and is adopted', async () => {
    await livePair(rig);
    rig.w.noteAnswer(G, 'p', 'p-b', 5, 5);
    await settle();
    const asked = rig.asked.length;
    rig.w.noteAnswer(G, 'p', 'p-b', 9, 2);
    await settle();
    expect(rig.asked.length).toBe(asked);
    expect(rig.pending.length).toBe(0);
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)!.have).toEqual({ haveVersion: 2, haveSince: 9 });
  });

  it('rf5 a page answer of another holder leaves the shown state, so an action view the tabs already show goes to no tab', async () => {
    await livePair(rig);
    rig.w.noteAnswer(G, 'p', 'p-c', 9, 2);
    await settle();
    const before = rig.updates.length;
    expect(rig.w.shareActionView(G, 'p', 'p-b', view({ liveSince: 5, liveVersion: 3 }))).toBe(0);
    expect(rig.updates.length).toBe(before);
  });

  it('rf5 a page behind the version the tabs were sent gets the newer state again from the fetch', async () => {
    await livePair(rig);
    expect(rig.w.shareActionView(G, 'p', 'p-b', view({ liveVersion: 4 }))).toBe(1);
    const before = rig.updates.length;
    rig.w.noteAnswer(G, 'p', 'p-b', 5, 3);
    await settle();
    expect(rig.asked.at(-1)!.have).toEqual({ haveVersion: 3, haveSince: 5 });
    await drain(rig, () => answerOf(4, 'Kept v4'));
    expect(rig.updates.length).toBe(before + 1);
    expect(rig.updates.at(-1)!.response).toEqual({ content: 'Kept v4' });
  });
});

describe('rf5 answers kept for a pair not watched yet', () => {
  it('rf5 an open answer without a since is kept with its version for the watch', async () => {
    rig.w.noteOpened(G, 'p', 'p-b', null, 3);
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)!.have).toEqual({ haveVersion: 3, haveSince: null });
  });

  it('rf5 an open answer with a negative version is kept at version 0', async () => {
    rig.w.noteOpened(G, 'p', 'p-b', 5, -2);
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)!.have).toEqual({ haveVersion: 0, haveSince: 5 });
  });

  it('rf5 an open answer with a fractional version is kept at version 0', async () => {
    rig.w.noteOpened(G, 'p', 'p-b', 5, 2.5);
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)!.have).toEqual({ haveVersion: 0, haveSince: 5 });
  });

  it('rf5 at most 50 answers are kept: the 51st drops the oldest only', async () => {
    for (let i = 0; i <= 50; i++) rig.w.noteOpened(G, `p${i}`, 'p-b', 5, 3);
    rig.w.watch(G, 'p0', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)).toEqual({ panelId: 'p0', have: { haveVersion: 0, haveSince: null } });
    rig.w.watch(G, 'p1', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)).toEqual({ panelId: 'p1', have: { haveVersion: 3, haveSince: 5 } });
    rig.w.watch(G, 'p50', 'owner', 'BRAVO');
    expect(rig.asked.at(-1)).toEqual({ panelId: 'p50', have: { haveVersion: 3, haveSince: 5 } });
  });
});

describe('rf5 stop', () => {
  it('rf5 stop ends every watch and closes the listening connection', async () => {
    await livePair(rig);
    expect(rig.w.count()).toBe(1);
    expect(rig.w.listenerUp()).toBe(true);
    rig.w.stop();
    expect(rig.w.count()).toBe(0);
    expect(rig.w.listenerUp()).toBe(false);
    expect(rig.clients.length).toBe(1);
    expect(rig.clients[0].end).toHaveBeenCalledTimes(1);
  });
});

describe('rf5 the status line of a pair', () => {
  it('rf5 a pair waiting for its refetch is reported and answered as not live, being updated', async () => {
    await livePair(rig);
    rig.w.noteAnswer(G, 'p', 'p-c', 5, 3, { sent: 1, refused: false, arrivedAt: 0 });
    await settle();
    expect(statusesOf(rig, 'p').at(-1)).toEqual({ live: false, reason: LIVE_REASONS.updating });
    expect(rig.w.watch(G, 'p', 'owner', 'BRAVO')).toEqual({ live: false, reason: LIVE_REASONS.updating });
  });

  it('rf5 an unchanged status is sent to the page once', async () => {
    await livePair(rig);
    const count = statusesOf(rig, 'p').length;
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    await drain(rig);
    rig.w.watch(G, 'p', 'owner', 'BRAVO');
    await drain(rig);
    expect(statusesOf(rig, 'p').length).toBe(count);
  });

  it('rf5 a pair watched while the listener is up has its first live status sent', async () => {
    await livePair(rig);
    rig.w.watch(G, 'q', 'owner', 'BRAVO');
    await drain(rig);
    expect(statusesOf(rig, 'q')).toEqual([{ live: true, reason: null }]);
  });
});

describe('rf5 closing the listener after the last watch ends', () => {
  it('rf5 the listener closes 60 s after the last watch ends, not after an earlier one ends', async () => {
    await livePair(rig, 'p');
    await vi.advanceTimersByTimeAsync(10_000);
    rig.w.watch(G, 'q', 'owner', 'BRAVO');
    await drain(rig);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(rig.w.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rig.w.count()).toBe(0);
    expect(rig.w.listenerUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(rig.w.listenerUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(rig.w.listenerUp()).toBe(false);
  });
});
