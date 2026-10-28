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

afterEach(() => {
  setGuildDataBackend(null);
  setBackendKind(null);
});

describe('store id adoption before provisioning passes', () => {
  it('answers pending with the operator reason', async () => {
    h.marker = JSON.stringify({ live: 'postgres', storeId: null, flippedAt: 1 });
    expect(await verifyStoreIdentity('postgres://x', false)).toEqual({
      ok: false,
      reason: 'the store id is adopted once provisioning passes',
      pending: true,
    });
  });
});

describe('graveyard restore with no owner info', () => {
  it('passes the fallback fence token', async () => {
    const tokens: any[] = [];
    setBackendKind('postgres');
    setGuildDataBackend({
      restoreGuild: async (_g: string, _b: number, token: any) => { tokens.push(token); return { ok: true, moved: 0 }; },
    } as any);
    expect(await restoreGuildFromGraveyard('g', 5)).toEqual({ ok: true, moved: 0 });
    expect(tokens).toEqual([{ nodeId: '', claim: null, shardId: 0, shardCount: 1 }]);
  });
});
