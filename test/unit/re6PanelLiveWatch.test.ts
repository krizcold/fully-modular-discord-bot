import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { LIVE_REASONS, PanelLiveWatch, actionViewVersion, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';

const G = '4194304';

class StuckListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: () => undefined } };
  constructor(readonly config: unknown) { super(); }
  connect() { return new Promise<void>(() => undefined); }
  query() { return Promise.resolve({ rows: [] }); }
  end() { return Promise.resolve(); }
}

interface Fetch { have: { haveVersion: number; haveSince: number | null }; done: (a: FetchAnswer) => void }

function rig() {
  const fetches: Fetch[] = [];
  const updates: unknown[] = [];
  const deps: WatchDeps = {
    fetch: (_g, _p, _u, have) => new Promise(done => { fetches.push({ have, done }); }),
    emitUpdate: data => { updates.push(data.response); return 1; },
    emitStatus: () => undefined,
    entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
    makeClient: config => new StuckListen(config) as any,
  };
  return { w: new PanelLiveWatch(deps), fetches, updates };
}

const answer = (reply: Record<string, unknown>): FetchAnswer => ({ status: null, holderProcess: 'p-b', reply: { success: true, notifying: true, servedBy: 'BRAVO', ...reply } });
const settle = () => vi.advanceTimersByTimeAsync(0);

let watchers: PanelLiveWatch[] = [];
function make() {
  const r = rig();
  watchers.push(r.w);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
  for (const w of watchers) w.stop();
  watchers = [];
  vi.useRealTimers();
});

describe('re6 the lines under a panel', () => {
  it('the reasons read as the operator sees them', () => {
    expect(LIVE_REASONS.tooLarge).toBe('the latest change is more than the 256 KiB one machine sends to another');
    expect(LIVE_REASONS.connecting).toBe('this web panel is still connecting');
    expect(LIVE_REASONS.updating).toBe('this panel is being updated to its latest state');
  });

  it('a first watch while the listener connects says it is still connecting', () => {
    const { w } = make();
    expect(w.watch(G, 'p', 'u', 'BRAVO')).toEqual({ live: false, reason: 'this web panel is still connecting' });
  });
});

describe('re6 actionViewVersion', () => {
  it('a negative liveVersion holds no view', () => {
    expect(actionViewVersion({ liveSince: 5, liveVersion: -1, data: { content: 'x' } })).toBe(0);
    expect(actionViewVersion({ liveSince: 5, liveVersion: 2, data: { content: 'x' } })).toBe(2);
  });
});

describe('re6 the watcher', () => {
  it('a new watcher is not listening, nor is one whose connection has not connected', async () => {
    const { w } = make();
    expect(w.listenerUp()).toBe(false);
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    expect(w.listenerUp()).toBe(false);
  });

  it('one watch call sends one fetch', async () => {
    const { w, fetches } = make();
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    expect(fetches.length).toBe(1);
    fetches[0].done(answer({ data: null, since: 5, version: 0 }));
    await settle();
    await settle();
    expect(fetches.length).toBe(1);
  });

  it('a watch that ended and starts again asks for the whole state, not the kept answer of the first', async () => {
    const { w, fetches } = make();
    w.noteAnswer(G, 'p', 'p-b', 5, 1);
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    expect(fetches[0].have).toEqual({ haveVersion: 1, haveSince: 5 });
    fetches[0].done(answer({ data: null, since: 5, version: 1 }));
    await settle();
    await vi.advanceTimersByTimeAsync(90_001);
    expect(w.count()).toBe(0);
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    expect(fetches.length).toBe(2);
    expect(fetches[1].have).toEqual({ haveVersion: 0, haveSince: null });
  });

  it('an opened answer without a view leaves the tabs shown nothing: an action sent before a later fetch is refused', async () => {
    const { w, fetches, updates } = make();
    w.noteAnswer(G, 'p', 'p-b', 5, 0);
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    fetches[0].done(answer({ data: null, since: 7, version: 0 }));
    await settle();
    const mark = w.applyMark();
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    expect(fetches.length).toBe(2);
    fetches[1].done(answer({ data: null, since: 5, version: 0 }));
    await settle();
    expect(w.applyMark()).toBe(mark + 1);
    const arrival = w.actionArrived(G, 'p', 'p-b', { liveSince: 5, liveVersion: 1, data: { content: 'after' } }, mark);
    expect(arrival.refused).toBe(true);
    expect(arrival.sent).toBe(0);
    expect(updates).toEqual([]);
  });

  it('an action view under a new since of the same holder reaches the tabs, though they show a higher version of the old since', async () => {
    const { w, fetches, updates } = make();
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    fetches[0].done(answer({ data: { content: 'v3' }, since: 5, version: 3 }));
    await settle();
    expect(updates).toEqual([{ content: 'v3' }]);
    const sent = w.shareActionView(G, 'p', 'p-b', { liveSince: 6, liveVersion: 1, data: { content: 'new since' } });
    expect(sent).toBe(1);
    expect(updates).toEqual([{ content: 'v3' }, { content: 'new since' }]);
  });

  it('an action view under the same since from another holder process reaches the tabs', async () => {
    const { w, fetches, updates } = make();
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    fetches[0].done(answer({ data: { content: 'v3' }, since: 5, version: 3 }));
    await settle();
    const sent = w.shareActionView(G, 'p', 'p-c', { liveSince: 5, liveVersion: 1, data: { content: 'other process' } });
    expect(sent).toBe(1);
    expect(updates).toEqual([{ content: 'v3' }, { content: 'other process' }]);
  });

  it('an action view no newer than the version the page has is not sent, though the tabs were sent nothing', async () => {
    const { w, updates } = make();
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    w.noteAnswer(G, 'p', 'p-b', 5, 3);
    const arrival = w.actionArrived(G, 'p', 'p-b', { liveSince: 5, liveVersion: 2, data: { content: 'older' } });
    expect(arrival).toEqual({ sent: 0, refused: false, arrivedAt: 0 });
    expect(updates).toEqual([]);
  });

  it('an action answer without a view sends nothing to a watched pair and is not refused', async () => {
    const { w, fetches, updates } = make();
    w.watch(G, 'p', 'u', 'BRAVO');
    await settle();
    fetches[0].done(answer({ data: { content: 'v1' }, since: 5, version: 1 }));
    await settle();
    expect(updates).toEqual([{ content: 'v1' }]);
    const arrival = w.actionArrived(G, 'p', 'p-b', { data: { content: 'no since' } }, w.applyMark());
    expect(arrival.sent).toBe(0);
    expect(arrival.refused).toBe(false);
    expect(updates).toEqual([{ content: 'v1' }]);
    expect(w.actionArrived(G, 'other', 'p-b', { liveSince: 5, liveVersion: 1, data: { content: 'x' } }).refused).toBe(false);
  });
});
