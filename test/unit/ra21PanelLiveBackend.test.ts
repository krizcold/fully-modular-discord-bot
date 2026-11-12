import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// These tests read the module's state as it loads, so nothing here calls _resetPanelLive before the last one.
const backend = vi.hoisted(() => ({ kind: 'file' as 'file' | 'postgres' }));

vi.mock('../../src/utils/envLoader', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/utils/envLoader')>();
  return { ...real, resolveDataBackend: () => backend.kind };
});

import { _resetPanelLive, _setNotifyDb, noteLiveChange, registerInterest } from '../../src/bot/internalSetup/fleet/panelLive';

const G = '4194304';
const db = { notify: vi.fn(async (_payloads: string[]) => undefined) };

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  _setNotifyDb(db);
});
afterAll(() => {
  _resetPanelLive();
  vi.useRealTimers();
});

describe('whether the notifier runs, by data backend', () => {
  it('on the file backend a watched change is never announced', async () => {
    backend.kind = 'file';
    registerInterest(G, 'f');
    noteLiveChange(G, 'f', { v: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.notify).not.toHaveBeenCalled();
  });

  it('on the postgres backend a watched change is announced within a second', async () => {
    backend.kind = 'postgres';
    registerInterest(G, 'p');
    noteLiveChange(G, 'p', { v: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.notify).toHaveBeenCalledWith(expect.arrayContaining([JSON.stringify({ g: G, p: 'p' })]));
  });
});
