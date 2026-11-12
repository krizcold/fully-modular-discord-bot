import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PanelLiveWatch, type FetchAnswer, type WatchDeps } from '../../src/webui/utils/panelLiveWatch';

class FakeListen extends EventEmitter {
  readonly connection = { stream: { remoteAddress: '127.0.0.1', destroy: vi.fn() } };
  constructor(readonly config: unknown) { super(); }
  connect() { return Promise.resolve(); }
  query() { return Promise.resolve({ rows: [] }); }
  end() { return Promise.resolve(); }
}

type Have = { haveVersion: number; haveSince: number | null };

function makeRig(answer: () => FetchAnswer) {
  const asked: Have[] = [];
  const deps: WatchDeps = {
    fetch: (_g, _p, _u, have) => {
      asked.push(have);
      return Promise.resolve(answer());
    },
    emitUpdate: () => 1,
    emitStatus: () => undefined,
    entry: () => ({ entry: 'postgres://bot@localhost/bot' }),
    makeClient: config => new FakeListen(config) as any,
  };
  return { w: new PanelLiveWatch(deps), asked };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const isPlusZero = (n: number) => Object.is(n, 0);

describe('rg12 the version a fetch says the page has is never negative zero', () => {
  let rig: ReturnType<typeof makeRig>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    rig?.w.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rg12 an opened answer with version -0 starts the watch at version 0', async () => {
    rig = makeRig(() => ({ status: null, holderProcess: 'h', reply: { success: true, since: 1000, version: 1, notifying: true, data: {} } }));
    rig.w.noteOpened('g', 'p', 'h', 1000, -0);
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    expect(rig.asked.length).toBeGreaterThan(0);
    expect(rig.asked[0].haveSince).toBe(1000);
    expect(isPlusZero(rig.asked[0].haveVersion)).toBe(true);
    await settle();
  });

  it('rg12 a fetched state with version -0 is asked for again from version 0', async () => {
    rig = makeRig(() => ({ status: 200, holderProcess: 'h', reply: { success: true, since: 1000, version: -0, notifying: true, data: {} } }));
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    rig.w.watch('g', 'p', 'u', 'BRAVO');
    await settle();
    const later = rig.asked.slice(1);
    expect(later.length).toBeGreaterThan(0);
    for (const have of later) {
      expect(have.haveSince).toBe(1000);
      expect(isPlusZero(have.haveVersion)).toBe(true);
    }
  });
});
