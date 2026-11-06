import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ markerStoreId: undefined as undefined | (() => string | null) }));

vi.mock('../../src/utils/envLoader', async importOriginal => ({
  ...(await importOriginal<object>()),
  loadCredentials: () => ({ DATA_BACKEND_URL: 'postgres://nobody@127.0.0.1:9/none' }),
  resolveDataBackend: () => 'postgres',
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/recognitionGuard', async importOriginal => ({
  ...(await importOriginal<object>()),
  evaluateRecognitionGuard: () => ({ state: 'boot', live: 'postgres' }),
  verifyStoreIdentity: async () => ({ ok: true }),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => ({
  ...(await importOriginal<object>()),
  PostgresBackend: class {
    constructor(opts: { markerStoreId?: () => string | null }) { h.markerStoreId = opts.markerStoreId; }
    start() {}
    stop() { return Promise.resolve(); }
    provisionVerdict() { return new Promise(() => {}); }
    onHoldChanged() {}
    setMoveSteps() {}
    chosenEntry() { return null; }
  },
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => ({
  ...(await importOriginal<object>()),
  initWorkingSet: () => ({}),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => ({
  ...(await importOriginal<object>()),
  initDataReadiness: () => ({ release() {}, stop() {} }),
  getDataReadiness: () => ({ causeOf: () => 'loading' }),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => ({
  ...(await importOriginal<object>()),
  setGuildDataBackend: () => {},
  closeGuildWrites: () => {},
}));

// NB16-R3-T2 and NB16-R3-RUN-2: the boot hands PostgresBackend the store id the marker records, and a marker that
// exists but can't be read makes that read throw instead of answering "no id".

const markerFile = () => path.join(process.env.DATA_DIR as string, '.backend.json');

beforeEach(() => {
  vi.resetModules();
  h.markerStoreId = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(markerFile(), { recursive: true, force: true });
});

async function bootRead(): Promise<() => string | null> {
  const mod = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
  mod.initDataBackendLayer();
  expect(h.markerStoreId).toBeTypeOf('function');
  return h.markerStoreId!;
}

describe('the store id the boot hands PostgresBackend', () => {
  it("is the marker's store id", async () => {
    fs.writeFileSync(markerFile(), JSON.stringify({ live: 'postgres', storeId: 'store-7', flippedAt: 1 }));
    expect((await bootRead())()).toBe('store-7');
  });

  it('is read when asked, not at boot', async () => {
    const read = await bootRead();
    fs.writeFileSync(markerFile(), JSON.stringify({ live: 'postgres', storeId: 'store-8', flippedAt: 1 }));
    expect(read()).toBe('store-8');
  });

  it('is null with no marker file, or a marker that records no id', async () => {
    const read = await bootRead();
    expect(read()).toBeNull();
    fs.writeFileSync(markerFile(), JSON.stringify({ live: 'postgres', storeId: null, flippedAt: 1 }));
    expect(read()).toBeNull();
  });

  it('throws, naming the marker, when it exists but can not be parsed', async () => {
    fs.writeFileSync(markerFile(), '{"live": "postgres", "storeId": "sto');
    expect(await bootRead()).toThrow(`this machine's marker ${markerFile()} cannot be parsed, so the store id it records is unknown; no store id was written and nothing was refused`);
  });

  it('throws when it exists but can not be read', async () => {
    fs.mkdirSync(markerFile());
    expect(await bootRead()).toThrow(new RegExp(`^this machine's marker ${markerFile().replace(/[\\.]/g, m => `\\${m}`)} cannot be read \\(.+\\), so the store id it records is unknown`));
  });

  it('throws when it parses but names neither file nor postgres', async () => {
    fs.writeFileSync(markerFile(), JSON.stringify({ storeId: 'store-9' }));
    expect(await bootRead()).toThrow(`this machine's marker ${markerFile()} does not name file or postgres, so the store id it records is unknown`);
  });
});
