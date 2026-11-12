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
type Pending = { panelId: string; have: Have; done: (a: FetchAnswer) => void; fail: (e: unknown) => void };

function makeRig(opts: { auto?: () => FetchAnswer; entry?: () => { entry: string } | { refusal: string } } = {}) {
  const pending: Pending[] = [];
  const asked: { panelId: string; have: Have }[] = [];
  const updates: { panelId: string; response: unknown; servedBy: string }[] = [];
  const statuses: { panelId: string; live: boolean; reason: string | null }[] = [];
  const deps: WatchDeps = {
    fetch: (_g, panelId, _u, have) => {
      asked.push({ panelId, have });
      if (opts.auto) return Promise.resolve(opts.auto());
      return new Promise((done, fail) => { pending.push({ panelId, have, done, fail }); });
    },
    emitUpdate: data => { updates.push({ panelId: data.panelId, response: data.response, servedBy: data.servedBy }); return 1; },
    emitStatus: data => { statuses.push({ panelId: data.panelId, live: data.live, reason: data.reason }); },
    entry: opts.entry ?? (() => ({ entry: 'postgres://bot@localhost/bot' })),
    makeClient: config => new FakeListen(config) as any,
  };
  return { w: new PanelLiveWatch(deps), pending, asked, updates, statuses };
}

type Rig = ReturnType<typeof makeRig>;

const settle = () => vi.advanceTimersByTimeAsync(0);
const ok = (over: Record<string, unknown> = {}): FetchAnswer => ({
  status: null, holderProcess: 'p-b', reply: { success: true, data: { content: 'Kept state' }, since: 5, version: 3, notifying: true, servedBy: 'BRAVO', ...over },
});

async function drain(r: Rig, answer: () => FetchAnswer = () => ok()) {
  await settle();
  for (let i = 0; i < 50 && r.pending.length; i++) { r.pending.shift()!.done(answer()); await settle(); }
  expect(r.pending.length).toBe(0);
}

/** Watched and listening, with the first fetch (sent before the listener was up) still unanswered. */
async function watchedWithFirstFetchOpen(r: Rig, panelId = 'p') {
  r.w.watch(G, panelId, 'owner', 'BRAVO');
  await settle();
  expect(r.w.listenerUp()).toBe(true);
  expect(r.pending.length).toBe(1);
}

describe('rf6 fake clock', () => {
  let rig: Rig;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rig.w.stop();
    warn.mockRestore();
    vi.useRealTimers();
  });

  describe('rf6 a fetch that fails', () => {
    it('rf6 a fetch that throws marks the panel not fetched and logs the cause', async () => {
      await watchedWithFirstFetchOpen(rig);
      rig.pending.shift()!.fail(new Error('socket closed'));
      await settle();
      expect(rig.statuses.at(-1)).toEqual({ panelId: 'p', live: false, reason: LIVE_REASONS.notFetched });
      expect(warn).toHaveBeenCalledWith('[PanelLive] Could not fetch the new state of panel p of server guild-1 from BRAVO (socket closed)');
    });

    it('rf6 a refused fetch without an error text logs "no answer"', async () => {
      await watchedWithFirstFetchOpen(rig);
      rig.pending.shift()!.done({ status: 500, reply: { success: false } });
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('[PanelLive] Could not fetch the new state of panel p of server guild-1 from BRAVO (no answer)');
      expect(rig.statuses.at(-1)).toEqual({ panelId: 'p', live: false, reason: LIVE_REASONS.notFetched });
    });

    it('rf6 a refused fetch logs the error text the holder answered', async () => {
      await watchedWithFirstFetchOpen(rig);
      rig.pending.shift()!.done({ status: 500, reply: { success: false, error: 'holder busy' } });
      await settle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('[PanelLive] Could not fetch the new state of panel p of server guild-1 from BRAVO (holder busy)');
    });
  });

  describe('rf6 what a fetched state carries', () => {
    it('rf6 a fetched state without servedBy goes to the tabs under the watched name', async () => {
      await watchedWithFirstFetchOpen(rig);
      rig.pending.shift()!.done(ok({ servedBy: undefined }));
      await settle();
      expect(rig.updates.length).toBe(1);
      expect(rig.updates[0].servedBy).toBe('BRAVO');
    });

    it('rf6 a fetched state names the machine its answer named', async () => {
      await watchedWithFirstFetchOpen(rig);
      rig.pending.shift()!.done(ok({ servedBy: 'CHARLIE' }));
      await settle();
      expect(rig.updates.length).toBe(1);
      expect(rig.updates[0].servedBy).toBe('CHARLIE');
    });

    it('rf6 an answer without a since leaves the panel not live (too many panels)', async () => {
      rig.w.watch(G, 'p', 'owner', 'BRAVO');
      await drain(rig, () => ok({ since: undefined }));
      expect(rig.asked.length).toBe(2);
      expect(rig.statuses.at(-1)).toEqual({ panelId: 'p', live: false, reason: LIVE_REASONS.tooMany });
    });

    for (const [label, version] of [['no version', undefined], ['a fractional version', 2.5], ['a negative version', -3]] as const) {
      it(`rf6 an answer with ${label} is kept as version 0 for the next request`, async () => {
        await watchedWithFirstFetchOpen(rig);
        rig.pending.shift()!.done(ok({ version }));
        await settle();
        expect(rig.asked.length).toBe(2);
        expect(rig.asked[1].have).toEqual({ haveVersion: 0, haveSince: 5 });
      });
    }
  });

  describe('rf6 the fetch queue', () => {
    it('rf6 a queued panel asked for twice is fetched once when a slot frees', async () => {
      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) rig.w.watch(G, id, 'owner', 'BRAVO');
      await settle();
      expect(rig.w.listenerUp()).toBe(true);
      expect(rig.asked.filter(a => a.panelId === 'p5').length).toBe(0);
      rig.w.watch(G, 'p5', 'owner', 'BRAVO');
      await drain(rig);
      expect(rig.asked.filter(a => a.panelId === 'p5').length).toBe(1);
    });

    it('rf6 a panel whose watch ended during its fetch is not fetched again', async () => {
      await watchedWithFirstFetchOpen(rig);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(rig.w.count()).toBe(0);
      rig.pending.shift()!.done(ok());
      await settle();
      expect(rig.asked.length).toBe(1);
      expect(rig.pending.length).toBe(0);
    });
  });

  describe('rf6 closing the listener', () => {
    it('rf6 the listener closes 60 s after the last watch ends, not after an earlier one', async () => {
      rig.w.watch(G, 'a', 'owner', 'BRAVO');
      await drain(rig);
      await vi.advanceTimersByTimeAsync(30_000);
      rig.w.watch(G, 'b', 'owner', 'BRAVO');
      await drain(rig);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rig.w.count()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rig.w.count()).toBe(0);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(rig.w.listenerUp()).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(rig.w.listenerUp()).toBe(false);
    });

    it('rf6 a watch that never got a connection leaves no timer once it ends', async () => {
      let calls = 0;
      const local = makeRig({ entry: () => { calls += 1; throw new Error('settings unreadable'); } });
      try {
        expect(() => local.w.watch(G, 'p', 'owner', 'BRAVO')).toThrow('settings unreadable');
        expect(calls).toBe(1);
        expect(local.w.count()).toBe(1);
        await vi.advanceTimersByTimeAsync(90_000);
        expect(local.w.count()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        local.w.stop();
      }
    });
  });
});

describe('rf6 real clock', () => {
  it('rf6 a finished fetch with nothing queued raises no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    const rig = makeRig({ auto: () => ok() });
    try {
      rig.w.watch(G, 'p', 'owner', 'BRAVO');
      const tick = () => new Promise<void>(resolve => setImmediate(resolve));
      for (let i = 0; i < 200 && !(rig.asked.length >= 2 && rig.statuses.at(-1)?.live === true); i++) await tick();
      expect(rig.asked.length).toBe(2);
      expect(rig.statuses.at(-1)).toEqual({ panelId: 'p', live: true, reason: null });
      for (let i = 0; i < 5; i++) await tick();
      expect(rejections).toEqual([]);
    } finally {
      rig.w.stop();
      process.off('unhandledRejection', onRejection);
    }
  });
});
