import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';

type Have = { haveVersion: number; haveSince: number | null };

function rig() {
  const answers: FetchAnswer[] = [];
  const asked: Have[] = [];
  const emitted: unknown[] = [];
  const deps: WatchDeps = {
    fetch: async (_g, _p, _u, have) => {
      asked.push(have);
      const answer = answers.shift();
      if (!answer) throw new Error('no scripted answer');
      return answer;
    },
    emitUpdate: data => { emitted.push(data.response); return 1; },
    emitStatus: () => undefined,
    entry: () => ({ refusal: 'no database in this test' }),
    makeClient: () => { throw new Error('no client in this test'); },
  };
  const w = new PanelLiveWatch(deps);
  const fetchOnce = async (answer: FetchAnswer) => {
    answers.push(answer);
    const before = asked.length;
    w.watch('g', 'p', 'u', 'BRAVO');
    expect(asked.length).toBe(before + 1);
    await vi.waitFor(() => { if (answers.length > 0) throw new Error('not fetched'); }, { timeout: 1000, interval: 1 });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { w, asked, emitted, fetchOnce };
}

const view = (marker: string) => ({ type: 'panel', marker });
const actionReply = (since: number, version: number) => ({ success: true, liveSince: since, liveVersion: version, data: { embeds: [], components: [] } });

let r: ReturnType<typeof rig>;
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { r?.w.stop(); vi.restoreAllMocks(); });

describe('rk9 a fetch that brings nothing new applies nothing', () => {
  it('rk9 an owner action sent before a fetch with no state and no change still reaches the tabs', async () => {
    r = rig();
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, reply: { success: true, notifying: true } });
    expect(r.emitted).toEqual([]);
    expect(r.w.applyMark()).toBe(mark);
    const arrival = r.w.actionArrived('g', 'p', undefined, actionReply(7, 1), mark);
    expect(arrival.refused).toBe(false);
    expect(arrival.sent).toBe(1);
  });

  it('rk9 a fetch whose answer has no data sends no view to the tabs, even from a new holder', async () => {
    r = rig();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 5, version: 3, notifying: true } });
    expect(r.emitted).toEqual([]);
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 5, version: 3, notifying: true, data: view('a') } });
    expect(r.emitted).toEqual([view('a')]);
    expect(r.asked[1]).toEqual({ haveVersion: 0, haveSince: 5 });
  });
});

describe('rk9 the version the page has after a fetch', () => {
  it('rk9 a state of a new holder at a lower version replaces the version, and its next change reaches the tabs', async () => {
    r = rig();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true, data: view('p1v5') } });
    await r.fetchOnce({ status: 200, holderProcess: 'p2', reply: { success: true, since: 2, version: 2, notifying: true, data: view('p2v2') } });
    await r.fetchOnce({ status: 200, holderProcess: 'p2', reply: { success: true, since: 2, version: 3, notifying: true, data: view('p2v3') } });
    expect(r.asked[2]).toEqual({ haveVersion: 2, haveSince: 2 });
    expect(r.emitted).toEqual([view('p1v5'), view('p2v2'), view('p2v3')]);
  });

  it('rk9 a stale answer of the same holder keeps the newer version and applies nothing', async () => {
    r = rig();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true, data: view('v5') } });
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    expect(r.w.applyMark()).toBe(mark);
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true } });
    expect(r.asked[1]).toEqual({ haveVersion: 5, haveSince: 1 });
    expect(r.asked[2]).toEqual({ haveVersion: 5, haveSince: 1 });
    expect(r.emitted).toEqual([view('v5')]);
  });
});
