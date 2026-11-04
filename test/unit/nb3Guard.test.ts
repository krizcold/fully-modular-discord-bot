import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateRecognitionGuard, readFileMarker, recognitionRefusal, verifyStoreIdentity, writeFileMarker,
} from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { setBackendKind } from '../helpers/backendKind';
import { JOURNAL, MARKER, STORES, seedFile, wipeRoot, writeJson } from '../helpers/migrationRig';

// NB3 decisions 5 and 13: what the boot guard says after a migration.

const pg = vi.hoisted(() => ({ storeId: 'store-db' as string | null, opened: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend')>();
  class Spy {
    constructor() { pg.opened += 1; }
    start() {}
  }
  return { ...real, readStoreId: async () => pg.storeId, PostgresBackend: Spy };
});

const CANT = /can't confirm which store holds the data/;

beforeEach(() => {
  wipeRoot();
  pg.opened = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const marker = (m: object) => writeJson(MARKER, { flippedAt: 1, storeId: null, ...m });
const journal = (j: object) => writeJson(JOURNAL, { startedAt: 1, ...j });

describe('the marker\'s migration field', () => {
  it('refuses every mismatch, also with no numeric folders, naming the unfinished job', () => {
    marker({ live: 'postgres', storeId: 's2', migration: 'job-guard-0001' });
    journal({ jobId: 'job-guard-0001', to: 'postgres', stage: 'env', storeId: 's2' });
    setBackendKind('file');
    const v = evaluateRecognitionGuard();
    expect(v.state).toBe('refused');
    expect((v as any).reason).toMatch(/A migration is unfinished; run it again with --to postgres to finish it/);
    expect((v as any).reason).toContain('job-guard-0001');
    expect(recognitionRefusal()).toBe((v as any).reason);
  });

  it('after done, or when the journal is a later job\'s, names where the data went', () => {
    marker({ live: 'file', migration: 'job-guard-0002' });
    journal({ jobId: 'job-guard-0002', to: 'file', stage: 'switching', result: 'done' });
    setBackendKind('postgres');
    expect(recognitionRefusal()).toBe('Migration job-guard-0002 moved the data to file; set DATA_BACKEND to file, or run a migration');
    journal({ jobId: 'job-guard-0003', to: 'postgres', stage: 'checking', result: 'failed' });
    expect(recognitionRefusal()).toBe('Migration job-guard-0002 moved the data to file; set DATA_BACKEND to file, or run a migration');
    fs.writeFileSync(STORES, JSON.stringify({ storeIds: [] }));
    expect(evaluateRecognitionGuard().state).toBe('refused');
  });

  it('readFileMarker returns the field and the guard\'s own writes keep it', async () => {
    marker({ live: 'postgres', storeId: null, migration: 'job-guard-0004' });
    journal({ jobId: 'job-guard-0004', to: 'postgres', stage: 'env', result: 'done' });
    expect(readFileMarker()?.migration).toBe('job-guard-0004');
    setBackendKind('postgres');
    expect(evaluateRecognitionGuard()).toEqual({ state: 'boot', live: 'postgres' });
    expect(await verifyStoreIdentity('postgres://x', true)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf-8'))).toMatchObject({ storeId: 'store-db', migration: 'job-guard-0004' });
    writeFileMarker({ ...readFileMarker()!, flippedAt: 2 });
    expect(readFileMarker()?.migration).toBe('job-guard-0004');
  });
});

describe('the early refusal for a retired Postgres source', () => {
  const setup = (stage: string, result?: string) => {
    marker({ live: 'postgres', storeId: 'src-1' });
    journal({ jobId: 'job-early-0001', to: 'file', stage, sourceStoreId: 'src-1', ...(result ? { result } : {}) });
    fs.writeFileSync(STORES, JSON.stringify({ storeIds: ['src-1'] }));
    setBackendKind('postgres');
  };

  it('at switching: "A migration is unfinished; run it again with --to file to finish it", and no backend opens', async () => {
    setup('switching');
    const v = evaluateRecognitionGuard();
    expect(v.state).toBe('refused');
    expect((v as any).reason).toContain('A migration is unfinished; run it again with --to file to finish it');
    const { initDataBackendLayer } = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    initDataBackendLayer();
    expect(pg.opened).toBe(0);
  });

  it('at retire-source with a failed result: "The old store still serves; run it again to start over"', () => {
    setup('retire-source', 'failed');
    expect((evaluateRecognitionGuard() as any).reason).toContain('The old store still serves; run it again to start over');
  });

  it('at retire-source with no result or an interrupted one: "can\'t confirm whether migration <id> retired the old store"', () => {
    for (const result of [undefined, 'interrupted']) {
      setup('retire-source', result);
      expect((evaluateRecognitionGuard() as any).reason).toContain(
        "can't confirm whether migration job-early-0001 retired the old store; run it again with --to file to finish it or start over");
    }
  });

  it('refuses nothing early for a journal to postgres, a null or other source id, or another stage', () => {
    const cases: object[] = [
      { jobId: 'job-early-0002', to: 'postgres', stage: 'switching', sourceStoreId: 'src-1' },
      { jobId: 'job-early-0003', to: 'file', stage: 'switching', sourceStoreId: null },
      { jobId: 'job-early-0004', to: 'file', stage: 'switching', sourceStoreId: 'other' },
      { jobId: 'job-early-0005', to: 'file', stage: 'placing', sourceStoreId: 'src-1' },
      { jobId: 'job-early-0006', to: 'file', stage: 'switching', sourceStoreId: 'src-1', result: 'done' },
    ];
    for (const j of cases) {
      marker({ live: 'postgres', storeId: 'src-1' });
      journal(j);
      setBackendKind('postgres');
      expect(evaluateRecognitionGuard(), JSON.stringify(j)).toEqual({ state: 'boot', live: 'postgres' });
    }
  });
});

describe('a missing, unreadable or unparsable marker or journal', () => {
  it('an unparsable marker refuses and stays byte for byte; recognitionRefusal gives the same text', () => {
    fs.writeFileSync(MARKER, '{"live": "postg');
    setBackendKind('file');
    const v = evaluateRecognitionGuard();
    expect((v as any).reason).toMatch(CANT);
    expect((v as any).reason).toContain(MARKER);
    expect(fs.readFileSync(MARKER, 'utf-8')).toBe('{"live": "postg');
    expect(recognitionRefusal()).toMatch(CANT);
  });

  it('a marker that does not exist beside a journal refuses and stays absent', () => {
    journal({ jobId: 'job-miss-0001', to: 'postgres', stage: 'copying' });
    setBackendKind('file');
    expect((evaluateRecognitionGuard() as any).reason).toMatch(CANT);
    expect(fs.existsSync(MARKER)).toBe(false);
  });

  it('an unknown live, a journal without jobId, to or stage, and a journal missing beside a migration marker refuse', () => {
    setBackendKind('file');
    marker({ live: 'disk' });
    expect((evaluateRecognitionGuard() as any).reason).toMatch(CANT);
    marker({ live: 'file' });
    for (const bad of [{ to: 'file', stage: 'checking' }, { jobId: 'j', stage: 'checking' }, { jobId: 'j', to: 'file' }]) {
      writeJson(JOURNAL, bad);
      expect((evaluateRecognitionGuard() as any).reason).toMatch(CANT);
    }
    fs.rmSync(JOURNAL);
    marker({ live: 'file', migration: 'job-gone-0001' });
    expect((evaluateRecognitionGuard() as any).reason).toMatch(CANT);
  });

  it('a bot that never migrated (no journal, no store list, no marker) boots and gets a marker', () => {
    seedFile('123123123123123123/mod/a.json', '{}');
    setBackendKind('file');
    expect(evaluateRecognitionGuard()).toEqual({ state: 'boot', live: 'file' });
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf-8')).live).toBe('file');
  });
});
