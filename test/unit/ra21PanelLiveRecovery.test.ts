import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// This test reads the failure log's state as the module loads it, so nothing calls _resetPanelLive before it.
import { _resetPanelLive, _setNotifyDb, isNotifying, noteLiveChange, notifyTick, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';

const G = '4194304';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});
afterAll(() => {
  _resetPanelLive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the recovery log', () => {
  it('says announcing works again only after a failure was logged', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let reject!: (error: Error) => void;
    const db = {
      notify: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((_, rej) => { reject = rej; }))
        .mockImplementation(async () => undefined),
    };
    _setNotifyDb(db, () => false);
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    const tick = notifyTick();
    vi.advanceTimersByTime(90_001);
    reject(new Error('connection refused'));
    await tick;
    expect(isNotifying()).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    registerInterest(G, 'q');
    noteLiveChange(G, 'q', { v: 1 });
    await notifyTick();
    expect(db.notify).toHaveBeenCalledTimes(2);
    expect(isNotifying()).toBe(true);
    expect(logs).not.toHaveBeenCalled();
  });
});
