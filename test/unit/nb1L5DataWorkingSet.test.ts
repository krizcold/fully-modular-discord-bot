import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';

afterEach(() => {
  vi.restoreAllMocks();
});

class OwnerlessDeposed extends FakeStore {
  async flushGuild(_guildId: string, _batch: GuildFlushBatch, _token: FenceToken): Promise<FlushOutcome> {
    return { ok: false, reason: 'deposed' };
  }
}

describe('the working set', () => {
  it('a second hydrate under the same grant joins the first and reads the store once', async () => {
    const store = new FakeStore();
    store.hydrateMode = 'held';
    const ws = new WorkingSetManager(store);
    const g = freshGuild();
    const token = tokenFor();
    const first = ws.hydrate(g, token);
    const second = ws.hydrate(g, token);
    store.releaseHydrations('unavailable');
    expect(await first).toBe('unavailable');
    expect(await second).toBe('unavailable');
    expect(store.hydrationsSent).toBe(1);
  });

  it('a frozen set is frozen before a newer grant only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new FakeStore();
    const ws = new WorkingSetManager(store);
    const g = freshGuild();
    const token = tokenFor();
    expect(await ws.hydrate(g, token)).toBe('ready');
    expect(ws.frozenBefore(g, tokenFor())).toBe(false);
    await ws.unloadToFrozenRetained(g);
    expect(ws.frozenBefore(g, token)).toBe(false);
    expect(ws.frozenBefore(g, tokenFor())).toBe(true);
  });

  it('an update read of a hydrating set counts no bypass read and warns nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new FakeStore();
    store.hydrateMode = 'held';
    const ws = new WorkingSetManager(store);
    const g = freshGuild();
    const pending = ws.hydrate(g, tokenFor());
    expect(ws.readForUpdate(g, 'm', 'doc.json')).toEqual({ status: 'not-ready' });
    expect(ws.getCounters().wsBypassReads).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    store.releaseHydrations();
    await pending;
  });

  it('a deposed flush with no owner named says unknown owner and claim', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new OwnerlessDeposed();
    const ws = new WorkingSetManager(store);
    const g = freshGuild();
    expect(await ws.hydrate(g, tokenFor())).toBe('ready');
    ws.save(g, 'm', 'doc.json', '{}');
    expect(await ws.flushGuildNow(g, 2000)).toBe('deposed');
    expect(ws.getBackendHealth().lastError).toBe(`guild ${g} fenced by unknown (claim ?)`);
    ws.evict(g);
  });
});
