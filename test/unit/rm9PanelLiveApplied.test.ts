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
const panelView = { embeds: [], components: [] };
const actionReply = (since: number, version: number) => ({ success: true, liveSince: since, liveVersion: version, data: panelView });

let r: ReturnType<typeof rig>;
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { r?.w.stop(); vi.restoreAllMocks(); });

describe('rm9 a fetch without a state applies a change of holder', () => {
  it('rm9 a new holder process and since with no state raise the apply mark and refuse an action sent before', async () => {
    r = rig();
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 5, notifying: true } });
    expect(r.emitted).toEqual([]);
    expect(r.w.applyMark()).toBe(mark + 1);
    const arrival = r.w.actionArrived('g', 'p', 'p1', actionReply(5, 1), mark);
    expect(arrival).toMatchObject({ sent: 0, refused: true });
  });

  it('rm9 a new holder process alone, with no since and no state, raises the apply mark', async () => {
    r = rig();
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, notifying: true } });
    expect(r.emitted).toEqual([]);
    expect(r.w.applyMark()).toBe(mark + 1);
  });

  it('rm9 a new since alone, from the same holder process and with no state, raises the apply mark', async () => {
    r = rig();
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, reply: { success: true, since: 9, notifying: true } });
    expect(r.emitted).toEqual([]);
    expect(r.w.applyMark()).toBe(mark + 1);
  });

  it('rm9 an answer with no state and no change leaves the apply mark', async () => {
    r = rig();
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, reply: { success: true, notifying: true } });
    expect(r.emitted).toEqual([]);
    expect(r.w.applyMark()).toBe(mark);
    const arrival = r.w.actionArrived('g', 'p', undefined, actionReply(7, 1), mark);
    expect(arrival).toMatchObject({ sent: 1, refused: false });
  });
});

describe('rm9 a fetched state the tabs were already sent by an owner action', () => {
  it('rm9 a state below the action view raises the version and the apply mark without being sent', async () => {
    r = rig();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    expect(r.w.actionArrived('g', 'p', 'p1', actionReply(1, 7)).sent).toBe(1);
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true, data: view('v5') } });
    expect(r.emitted).toEqual([view('v3'), panelView]);
    expect(r.w.applyMark()).toBe(mark + 1);
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true } });
    expect(r.asked[2]).toEqual({ haveVersion: 5, haveSince: 1 });
  });

  it('rm9 the state at the action view version raises the version but not the apply mark', async () => {
    r = rig();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    expect(r.w.actionArrived('g', 'p', 'p1', actionReply(1, 7)).sent).toBe(1);
    const mark = r.w.applyMark();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 7, notifying: true, data: view('v7') } });
    expect(r.emitted).toEqual([view('v3'), panelView]);
    expect(r.w.applyMark()).toBe(mark);
    const arrival = r.w.actionArrived('g', 'p', 'p1', actionReply(1, 8), mark);
    expect(arrival).toMatchObject({ sent: 1, refused: false });
  });
});

describe('rm9 the version kept after a stale state of the same holder', () => {
  it('rm9 an older state of the same holder process and since keeps the newer version for the next fetch', async () => {
    r = rig();
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 5, notifying: true, data: view('v5') } });
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 3, notifying: true, data: view('v3') } });
    await r.fetchOnce({ status: 200, holderProcess: 'p1', reply: { success: true, since: 1, version: 4, notifying: true, data: view('v4') } });
    expect(r.asked[2]).toEqual({ haveVersion: 5, haveSince: 1 });
    expect(r.emitted).toEqual([view('v5')]);
  });
});
