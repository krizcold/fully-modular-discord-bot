import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { restoreGuildFromGraveyard, setGuildDataBackend, setOwnerInfoProvider } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';

const held = new Map<number, number>();

afterEach(() => {
  setGuildDataBackend(null);
  setBackendKind(null);
  setOwnerInfoProvider(() => null);
  held.clear();
});

async function restoreEndingUnlanded(loseClaim: boolean) {
  setBackendKind('postgres');
  held.set(0, 7);
  setOwnerInfoProvider(() => ({ nodeId: 'node-a', processId: 'process-a', shardCount: 1, claimOf: s => held.get(s) ?? null }));
  const store = new FakeStore();
  const ws = initWorkingSet(store);
  let waiter: Promise<string> | null = null;
  store.restoreGuild = async () => {
    waiter = ws.awaitReady('1', 5000);
    if (loseClaim) held.delete(0);
    return { ok: false, reason: 'no-entry' };
  };
  setGuildDataBackend(store);
  expect(await ws.hydrate('1', { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
  const reply = await restoreGuildFromGraveyard('1', 5);
  expect(reply.ok).toBe(false);
  expect(waiter).not.toBeNull();
  return { state: ws.stateOf('1'), waited: await waiter! };
}

describe('NB11 item 6: a restore that ends unlanded reopens only a held shard', () => {
  it('reopens the guild while its shard is still held here', async () => {
    expect(await restoreEndingUnlanded(false)).toEqual({ state: 'ready', waited: 'ready' });
  });

  it('leaves the guild frozen-retained once the shard claim was lost', async () => {
    expect(await restoreEndingUnlanded(true)).toEqual({ state: 'frozen-retained', waited: 'ready' });
  });
});
