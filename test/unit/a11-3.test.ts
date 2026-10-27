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
  initWorkingSet: () => ({}),
  getWorkingSet: () => null,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => ({
  ...(await importOriginal<object>()),
  initDataReadiness: () => ({ release() {}, stop() {} }),
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
});
