import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { freshGuild } from '../helpers/gateRig';

// NB11 survivors, chunk 7 (wip-redesign/sheets/NB11.md): a working set held by a restore.

afterEach(() => {
  vi.restoreAllMocks();
});

async function readySet() {
  const store = new FakeStore();
  const ws = new WorkingSetManager(store);
  const g = freshGuild();
  const token = tokenFor();
  expect(await ws.hydrate(g, token)).toBe('ready');
  return { store, ws, g, token };
}

describe('a set held by a restore', () => {
  it('a hydrate under a new grant reads nothing and keeps the restore\'s fence', async () => {
    const { store, ws, g, token } = await readySet();
    expect(ws.beginRestore(g)).toBe(true);
    const sent = store.hydrationsSent;
    expect(await ws.hydrate(g, tokenFor())).toBe('unavailable');
    expect(store.hydrationsSent).toBe(sent);
    expect(ws.fenceOf(g)).toEqual(token);
    expect(ws.stateOf(g)).toBe('restoring');
    ws.endRestore(g, 'reopen');
    expect(ws.stateOf(g)).toBe('ready');
  });

  it('refuses a write as not ready and counts no bypass write', async () => {
    const { ws, g } = await readySet();
    expect(ws.beginRestore(g)).toBe(true);
    const before = ws.getCounters().wsBypassWrites;
    expect(ws.save(g, 'm', 'doc.json', '{"v":1}')).toBe('not-ready');
    expect(ws.getCounters().wsBypassWrites).toBe(before);
    expect(ws.dirtyGuildIds()).not.toContain(g);
    ws.endRestore(g, 'reopen');
  });
});

describe('ending a restore that does not hold the set', () => {
  it('an evict leaves a ready set served', async () => {
    const { ws, g } = await readySet();
    ws.endRestore(g, 'evict');
    expect(ws.has(g)).toBe(true);
    expect(ws.stateOf(g)).toBe('ready');
  });

  it('a reopen with the shard gone leaves a ready set ready', async () => {
    const { ws, g } = await readySet();
    ws.endRestore(g, 'reopen', () => false);
    expect(ws.stateOf(g)).toBe('ready');
  });
});
