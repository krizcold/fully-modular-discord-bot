import { pgConfig } from '../../src/utils/databaseAddress';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ marker: '' }));

vi.mock('fs', async importOriginal => {
  const real = await importOriginal<any>();
  const readFileSync = (p: any, ...rest: any[]) =>
    String(p).endsWith('.backend.json') ? h.marker : real.readFileSync(p, ...rest);
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  readStoreId: async () => 'store-A',
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => ({
  ...(await importOriginal<object>()),
  awaitGuildDataReady: async () => true,
}));

import { verifyStoreIdentity } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { restoreGuildFromGraveyard, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';
import { FakeStore } from '../helpers/fakeStore';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';

afterEach(() => {
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('store id adoption before provisioning passes', () => {
  it('answers pending with the operator reason', async () => {
    h.marker = JSON.stringify({ live: 'postgres', storeId: null, flippedAt: 1 });
    expect(await verifyStoreIdentity(pgConfig('postgres://x'), false)).toEqual({
      ok: false,
      reason: 'the store id is adopted once provisioning passes',
      pending: true,
    });
  });
});

describe('graveyard restore with no owner info (NB11)', () => {
  it('carries the claim of the set that serves the guild, and with no ready set calls no restore', async () => {
    const tokens: any[] = [];
    setBackendKind('postgres');
    const store = new FakeStore();
    store.restoreGuild = async (...args: unknown[]) => { tokens.push(args[2]); return { ok: true, copied: 0, retiredAt: 5, reason: 'r', usedAt: 1000 }; };
    const ws = initWorkingSet(store);
    setGuildDataBackend(store);
    expect(await ws.hydrate('1', { nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 })).toBe('ready');
    expect(await restoreGuildFromGraveyard('1', 5)).toEqual({ ok: true, copied: 0, retiredAt: 5, reason: 'r', keptUntil: expect.any(Number) });
    expect(tokens).toEqual([{ nodeId: 'node-a', claim: 7, processId: 'process-a', shardId: 0, shardCount: 1 }]);
    expect(await restoreGuildFromGraveyard('2', 5)).toMatchObject({ ok: false, code: 'backend-unavailable' });
    expect(tokens).toHaveLength(1);
  });
});
