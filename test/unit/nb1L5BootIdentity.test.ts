import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  provision: null as any,
  verify: null as any,
  storeId: 'store-1' as string | null,
  verifyCalls: 0,
  released: 0,
  served: 0,
  heldOpts: null as any,
  url: '' as string,
}));

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => ({ DATA_BACKEND_URL: h.url }),
  resolveDataBackend: () => 'postgres',
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async importOriginal => ({
  ...(await importOriginal<object>()),
  evaluateRecognitionGuard: () => ({ state: 'boot', live: 'postgres' }),
  readFileMarker: () => ({ live: 'postgres', storeId: h.storeId, flippedAt: 1 }),
  verifyStoreIdentity: () => {
    h.verifyCalls++;
    if (h.verifyCalls > 6) return new Promise(() => {});
    return h.verify();
  },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  PostgresBackend: class {
    start() {}
    stop() { return Promise.resolve(); }
    provisionVerdict() { return h.provision; }
  },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => ({
  ...(await importOriginal<object>()),
  initWorkingSet: () => ({}),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => ({
  ...(await importOriginal<object>()),
  initDataReadiness: (_b: unknown, _w: unknown, opts: unknown) => {
    h.heldOpts = opts;
    return { release() { h.released++; }, stop() {} };
  },
  getDataReadiness: () => null,
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => ({
  ...(await importOriginal<object>()),
  setGuildDataBackend: () => {},
  closeGuildWrites: () => {},
  noteGuildDataServing: () => { h.served++; },
}));

const PENDING = { ok: false, reason: 'still provisioning', pending: true };
let errors: any;
let warns: any;
let logs: any;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.assign(h, { verifyCalls: 0, released: 0, served: 0, heldOpts: null, storeId: 'store-1', url: 'postgres://u@127.0.0.1:9/db' });
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function boot() {
  const mod = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
  mod.initDataBackendLayer();
  await vi.advanceTimersByTimeAsync(1);
  return mod;
}

describe('the data boot refusals', () => {
  it('tells the operator to fix the setting when the URL is missing', async () => {
    h.url = '';
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(errors).toHaveBeenCalledWith('[Data] Gates stay closed; fix DATA_BACKEND/DATA_BACKEND_URL in the web UI env editor');
  });

  it('tells the operator to point the URL at a database of this schema version', async () => {
    h.provision = Promise.resolve({ state: 'mismatch', found: '{"v":1}' });
    h.verify = () => new Promise(() => {});
    const mod = await boot();
    expect(mod.getDataBootStatus().state).toBe('refused');
    expect(errors).toHaveBeenCalledWith("[Data] Gates stay closed; point DATA_BACKEND_URL at a database of this bot's schema version in the web UI env editor");
  });

  it('keeps the identity refusal when a schema mismatch arrives after it', async () => {
    const p = deferred<any>();
    h.provision = p.promise;
    h.verify = async () => ({ ok: false, reason: 'wrong store' });
    const mod = await boot();
    expect(mod.getDataBootStatus().refusalReason).toBe('wrong store');
    p.resolve({ state: 'mismatch', found: '{"v":1}' });
    await vi.advanceTimersByTimeAsync(1);
    expect(mod.getDataBootStatus().refusalReason).toBe('wrong store');
    expect(errors).toHaveBeenCalledTimes(2);
  });
});

describe('the identity loop', () => {
  it('holds the readiness driver until identity verifies, then serves', async () => {
    h.provision = Promise.resolve({ state: 'provisioned' });
    h.verify = async () => ({ ok: true });
    const mod = await boot();
    expect(h.heldOpts).toEqual({ held: true });
    expect(mod.getDataBootStatus().state).toBe('serving');
    expect(h.released).toBe(1);
    expect(h.served).toBe(1);
    expect(logs).toHaveBeenCalledWith('[Data] Postgres store identity verified; serving');
  });

  it('does not serve while the marker holds no store id', async () => {
    h.provision = Promise.resolve({ state: 'provisioned' });
    h.storeId = null;
    h.verify = async () => ({ ok: true });
    const mod = await boot();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(mod.getDataBootStatus().state).toBe('starting');
    expect(h.released).toBe(0);
  });

  it('stops asking at once when the backend stopped before the first check returned', async () => {
    h.provision = Promise.resolve({ state: 'stopped' });
    h.verify = async () => PENDING;
    await boot();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.verifyCalls).toBe(1);
    expect(warns).not.toHaveBeenCalled();
  });

  it('stops asking when the backend stops during the retry wait', async () => {
    const p = deferred<any>();
    h.provision = p.promise;
    h.verify = async () => PENDING;
    await boot();
    expect(h.verifyCalls).toBe(1);
    p.resolve({ state: 'stopped' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.verifyCalls).toBe(1);
  });

  it('waits the retry interval between checks while provisioning is pending', async () => {
    h.provision = new Promise(() => {});
    h.verify = async () => PENDING;
    await boot();
    expect(h.verifyCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.verifyCalls).toBe(2);
  });

  it('asks again at once when provisioning passes during the wait', async () => {
    const p = deferred<any>();
    h.provision = p.promise;
    h.verify = async () => PENDING;
    await boot();
    expect(h.verifyCalls).toBe(1);
    p.resolve({ state: 'provisioned' });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.verifyCalls).toBe(2);
  });

  it('waits the retry interval between checks once provisioning passed', async () => {
    h.provision = Promise.resolve({ state: 'provisioned' });
    h.verify = async () => PENDING;
    await boot();
    expect(h.verifyCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.verifyCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(4_100);
    expect(h.verifyCalls).toBe(3);
  });
});
