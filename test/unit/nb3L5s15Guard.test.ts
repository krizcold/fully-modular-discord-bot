import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANT_CONFIRM_STORE, MARKER_FILE, MIGRATION_FILE, STORES_FILE, readDataFacts, readFileMarker, verifyStoreIdentity,
  writeMarkerStrict,
} from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { JOURNAL, MARKER, STORES, freshJsonBot, readJson, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3 decisions 5 and 13: the texts "can't confirm which store holds the data" names its files by, the marker's
// strict write, and the store id adopted beside a migration's name.

const h = vi.hoisted(() => ({
  statError: null as null | { file: string; error: Error },
  readBack: null as null | { file: string; text: string },
  storeId: 'store-db' as string | null,
}));

vi.mock('fs', async orig => {
  const real = await orig<typeof import('fs')>();
  const path = await import('path');
  const same = (a: unknown, b: string) => path.resolve(String(a)) === path.resolve(b);
  const statSync = ((p: any, o?: any) => {
    if (h.statError && same(p, h.statError.file)) throw h.statError.error;
    return (real.statSync as any)(p, o);
  }) as typeof real.statSync;
  const readFileSync = ((p: any, o?: any) => {
    if (h.readBack && same(p, h.readBack.file)) return h.readBack.text;
    return (real.readFileSync as any)(p, o);
  }) as typeof real.readFileSync;
  return { ...real, statSync, readFileSync, default: { ...real, statSync, readFileSync } };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend')>();
  return { ...real, readStoreId: async () => h.storeId };
});

beforeEach(() => {
  wipeRoot();
  h.statError = null;
  h.readBack = null;
  h.storeId = 'store-db';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('readDataFacts names the file a missing one was expected beside', () => {
  it('a marker missing beside a journal names the journal', () => {
    writeJson(JOURNAL, { jobId: 'job-s15-0001', to: 'postgres', stage: 'copying', startedAt: 1 });
    expect(readDataFacts()).toEqual({ ok: false, reason: `${CANT_CONFIRM_STORE}: ${MARKER_FILE} is missing beside ${MIGRATION_FILE}` });
  });

  it('a marker and a journal missing beside the store list name the store list, the two problems joined by "; "', () => {
    writeJson(STORES, { storeIds: [] });
    expect(readDataFacts()).toEqual({
      ok: false,
      reason: `${CANT_CONFIRM_STORE}: ${MARKER_FILE} is missing beside ${STORES_FILE}; ${MIGRATION_FILE} is missing beside ${STORES_FILE}`,
    });
  });

  it('a journal missing beside a marker that names a migration names the marker and the migration', () => {
    writeJson(MARKER, { live: 'postgres', storeId: 's1', flippedAt: 1, migration: 'job-s15-0002' });
    expect(readDataFacts()).toEqual({
      ok: false,
      reason: `${CANT_CONFIRM_STORE}: ${MIGRATION_FILE} is missing beside ${MARKER_FILE}, which names migration job-s15-0002`,
    });
  });

  it('a store list that cannot be read is named with its error', () => {
    freshJsonBot();
    h.statError = { file: STORES_FILE, error: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) };
    expect(readDataFacts()).toEqual({ ok: false, reason: `${CANT_CONFIRM_STORE}: ${STORES_FILE} cannot be read (EACCES: permission denied)` });
  });
});

describe('writeMarkerStrict', () => {
  it('writes the marker and reads it back', () => {
    const marker = { live: 'postgres' as const, storeId: 's2', flippedAt: 2, migration: 'job-s15-0003' };
    writeMarkerStrict(marker);
    expect(readJson(MARKER)).toEqual(marker);
  });

  it('throws naming the marker when it does not read back as written', () => {
    h.readBack = { file: MARKER_FILE, text: '{"live":"file"}' };
    expect(() => writeMarkerStrict({ live: 'postgres', storeId: 's3', flippedAt: 3 })).toThrow(`${MARKER_FILE} does not read back as written`);
  });
});

describe('verifyStoreIdentity adopting the store id', () => {
  it('keeps the migration the marker names', async () => {
    writeJson(MARKER, { live: 'postgres', storeId: null, flippedAt: 5, migration: 'job-s15-0004' });
    expect(await verifyStoreIdentity('postgres://u:p@db.example:5432/smdb', true)).toEqual({ ok: true });
    expect(readJson(MARKER)).toEqual({ live: 'postgres', storeId: 'store-db', flippedAt: 5, migration: 'job-s15-0004' });
    expect(readFileMarker()).toEqual({ live: 'postgres', storeId: 'store-db', flippedAt: 5, migration: 'job-s15-0004' });
    expect(fs.existsSync(MARKER)).toBe(true);
  });
});
