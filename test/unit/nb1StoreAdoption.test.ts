import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verdict: { state: 'mismatch', found: '{"v":1}' } as any,
  storeId: 'store-v1' as string | null,
  released: 0,
}));

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => ({ DATA_BACKEND_URL: 'postgres://nobody@127.0.0.1:9/none' }),
  resolveDataBackend: () => 'postgres',
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  readStoreId: async () => h.storeId,
  PostgresBackend: class {
    start() {}
    stop() { return Promise.resolve(); }
    provisionVerdict() { return h.verdict === 'never' ? new Promise(() => {}) : Promise.resolve(h.verdict); }
  },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => ({
  ...(await importOriginal<object>()),
  initWorkingSet: () => ({}),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => ({
  ...(await importOriginal<object>()),
  initDataReadiness: () => ({ release() { h.released++; }, stop() {} }),
  getDataReadiness: () => ({ causeOf: () => 'loading' }),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => ({
  ...(await importOriginal<object>()),
  setGuildDataBackend: () => {},
  closeGuildWrites: () => {},
}));

const marker = path.join(process.env.DATA_DIR as string, '.backend.json');

function markerStoreId(): string | null {
  return JSON.parse(fs.readFileSync(marker, 'utf-8')).storeId;
}

beforeEach(() => {
  vi.resetModules();
  h.released = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fs.writeFileSync(marker, JSON.stringify({ live: 'postgres', storeId: null, flippedAt: 1 }));
});

afterEach(() => {
  fs.rmSync(marker, { force: true });
});

async function boot() {
  const mod = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
  mod.initDataBackendLayer();
  await new Promise(resolve => { setTimeout(resolve, 20); });
  return mod;
}

// NB1 round 3, R3-1: a fresh marker adopts a store id only once provisioning passed, so a database of another schema
// version never leaves its id behind.
describe('store id adoption into a fresh marker', () => {
  it('a schema mismatch boot leaves the store id unrecorded', async () => {
    h.verdict = { state: 'mismatch', found: '{"v":1}' };
    h.storeId = 'store-v1';
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(markerStoreId()).toBeNull();
  });

  it('a later boot against a provisioned database serves and adopts its store id', async () => {
    h.verdict = { state: 'mismatch', found: '{"v":1}' };
    h.storeId = 'store-v1';
    await boot();
    vi.resetModules();
    h.verdict = { state: 'provisioned' };
    h.storeId = 'store-v2';
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('serving');
    expect(h.released).toBe(1);
    expect(markerStoreId()).toBe('store-v2');
  });

  it('a marker holding another store id is still refused while provisioning has not passed', async () => {
    fs.writeFileSync(marker, JSON.stringify({ live: 'postgres', storeId: 'store-old', flippedAt: 1 }));
    h.verdict = 'never';
    h.storeId = 'store-v2';
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(mod.getDataBootStatus().refusalReason).toContain('store-old');
    expect(markerStoreId()).toBe('store-old');
  });
});
