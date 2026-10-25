import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  verdict: { state: 'boot', live: 'postgres' } as any,
  marker: null as any,
  creds: {} as Record<string, string>,
  written: [] as any[],
}));

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => h.creds,
  upsertCredentials: () => ({ success: true }),
  setFleetDataBackend: () => {},
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async importOriginal => ({
  ...(await importOriginal<object>()),
  evaluateRecognitionGuard: () => h.verdict,
  readFileMarker: () => h.marker,
  writeFileMarker: (m: any) => { h.written.push(m); h.marker = m; },
  verifyStoreIdentity: () => new Promise(() => {}),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  listGuilds: () => [],
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  PostgresBackend: class { start() {} stop() { return Promise.resolve(); } },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => ({
  ...(await importOriginal<object>()),
  initWorkingSet: () => ({ quiesce() {} }),
  getWorkingSet: () => null,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => ({
  ...(await importOriginal<object>()),
  initDataReadiness: () => ({ hold: () => true, release() {}, stop() {} }),
  getDataReadiness: () => null,
}));

beforeEach(() => {
  vi.resetModules();
  h.creds = {};
  h.marker = null;
  h.written = [];
});

async function load() {
  return await import('../../src/bot/internalSetup/utils/dataBackends/boot');
}

describe('data boot status texts', () => {
  it('a postgres refusal reports mode postgres', async () => {
    h.verdict = { state: 'boot', live: 'postgres' };
    const boot = await load();
    boot.initDataBackendLayer();
    const s = boot.getDataBootStatus();
    expect(s.state).toBe('refused');
    expect(s.mode).toBe('postgres');
  });

  it('drops the refusal reason once the data layer leaves refused', async () => {
    h.verdict = { state: 'boot', live: 'postgres' };
    const boot = await load();
    boot.initDataBackendLayer();
    expect(boot.getDataBootStatus().refusalReason).toMatch(/DATA_BACKEND_URL/);
    boot.ensureRuntimeWith('postgres://db.invalid:5432/x');
    const s = boot.getDataBootStatus();
    expect(s.state).toBe('starting');
    expect(s.refusalReason).toBeNull();
  });

  it('clears the transformation banner when a delivery rewrites the stale marker', async () => {
    h.verdict = { state: 'transformation-required', live: 'file', configured: 'postgres' };
    h.marker = { live: 'file', storeId: null, flippedAt: 1, transformationId: null };
    const boot = await load();
    boot.initDataBackendLayer();
    expect(boot.getDataBootStatus().banner).toMatch(/transformation/);
    await boot.applyDeliveredBackend({ backend: 'postgres', url: 'postgres://db.invalid:5432/x' }, { persist: false });
    expect(h.written.some(m => m.live === 'postgres')).toBe(true);
    expect(boot.getDataBootStatus().banner).toBeNull();
  });

  it('clears the banner when the delivery names the backend the marker already holds', async () => {
    h.verdict = { state: 'transformation-required', live: 'postgres', configured: 'file' };
    h.marker = { live: 'postgres', storeId: null, flippedAt: 1, transformationId: null };
    const boot = await load();
    boot.initDataBackendLayer();
    expect(boot.getDataBootStatus().banner).toMatch(/transformation/);
    await boot.applyDeliveredBackend({ backend: 'postgres', url: 'postgres://db.invalid:5432/x' }, { persist: false });
    expect(h.written).toEqual([]);
    expect(boot.getDataBootStatus().banner).toBeNull();
  });
});
