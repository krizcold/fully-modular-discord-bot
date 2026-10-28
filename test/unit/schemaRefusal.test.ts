import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verdict: { state: 'mismatch', found: '{"v":1}' } as any,
  identity: { ok: true } as any,
  released: 0,
  closed: 0,
}));

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => ({ DATA_BACKEND_URL: 'postgres://nobody@127.0.0.1:9/none' }),
  resolveDataBackend: () => 'postgres',
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async importOriginal => ({
  ...(await importOriginal<object>()),
  evaluateRecognitionGuard: () => ({ state: 'boot', live: 'postgres' }),
  readFileMarker: () => ({ live: 'postgres', storeId: 'store-1', flippedAt: 1 }),
  verifyStoreIdentity: async () => h.identity,
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
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
  closeGuildWrites: () => { h.closed++; },
}));

beforeEach(() => {
  vi.resetModules();
  h.released = 0;
  h.closed = 0;
  h.identity = { ok: true };
});

async function boot() {
  const mod = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
  mod.initDataBackendLayer();
  await new Promise(resolve => { setTimeout(resolve, 20); });
  return mod;
}

// NB1 round 1, F2: a database of another schema version keeps its store id, so the identity check passes; the data
// boot must still refuse it, as it refuses a wrong store.
describe('a database of another schema version', () => {
  it('refuses the data boot: state refused, guild writes closed, the readiness driver held, members read refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.verdict = { state: 'mismatch', found: '{"v":1}' };
    const mod = await boot();
    const status = mod.getDataBootStatus();
    expect(status.state).toBe('refused');
    expect(status.refusalReason).toContain('{"v":1}');
    expect(h.closed).toBe(1);
    expect(h.released).toBe(0);
    expect(mod.gateCauseNow('123', performance.now())).toBe('refused');
    const lines = error.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('DATA_BACKEND/DATA_BACKEND_URL'))).toBe(false);
  });

  it('serves once provisioning passed and the identity verified', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.verdict = { state: 'provisioned' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('serving');
    expect(h.released).toBe(1);
    expect(h.closed).toBe(0);
  });
});

// NB1 round 2, R2-4: the identity check runs beside the provisioning wait. Whichever refusal comes first refuses; the
// data boot serves only once both passed.
describe('the identity check beside the provisioning wait', () => {
  it('refuses a wrong store whose provisioning never finishes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.verdict = 'never';
    h.identity = { ok: false, pending: false, reason: 'the database holds another store' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(mod.getDataBootStatus().refusalReason).toBe('the database holds another store');
    expect(h.closed).toBe(1);
    expect(h.released).toBe(0);
  });

  it('refuses a schema mismatch while the identity is still pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = { state: 'mismatch', found: '{"v":1}' };
    h.identity = { ok: false, pending: true, reason: 'no identity yet' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(mod.getDataBootStatus().refusalReason).toContain('{"v":1}');
    expect(h.released).toBe(0);
  });

  it('does not serve on a verified identity while provisioning is pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = 'never';
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('starting');
    expect(h.released).toBe(0);
    expect(warn.mock.calls.some(c => String(c[0]).startsWith('[Data] Waiting on the data backend'))).toBe(true);
  });

  it('does not serve on a passed provisioning while the identity is pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verdict = { state: 'provisioned' };
    h.identity = { ok: false, pending: true, reason: 'no identity yet' };
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('starting');
    expect(h.released).toBe(0);
    expect(warn.mock.calls.some(c => String(c[0]).startsWith('[Data] Waiting on the data backend'))).toBe(true);
  });
});
