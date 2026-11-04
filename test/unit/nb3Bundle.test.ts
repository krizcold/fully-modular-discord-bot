import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRefusal, importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { emptyStore, FakeDb } from '../helpers/fakePg';
import { setBackendKind } from '../helpers/backendKind';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, root, seedFile, serviceFor, useDatabaseUrl, writeJson } from '../helpers/migrationRig';

// NB3 decisions 2, 5 and 14: a bundle import beside a migration.

const G = '151515151515151515';
const CANT = /can't confirm which store holds the data/;

beforeEach(() => {
  freshJsonBot();
  setBackendKind('file');
  useDatabaseUrl(PG_URL);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('bundleRefusal', () => {
  it('refuses while the panel reports a migration running, or cannot say', () => {
    expect(bundleRefusal(G, 'no', 'yes')).toMatch(/data migration is running/);
    expect(bundleRefusal(G, 'no', 'unknown')).toMatch(/could not confirm/);
    expect(bundleRefusal(G, 'unknown', 'unknown')).toMatch(/could not confirm/);
    expect(bundleRefusal(G, 'no', 'no')).toBeNull();
  });

  it('refuses with "can\'t confirm which store holds the data" for an unparsable marker or one missing beside a journal', () => {
    fs.writeFileSync(MARKER, '{');
    expect(bundleRefusal(G, 'no', 'no')).toMatch(CANT);
    fs.rmSync(MARKER);
    writeJson(JOURNAL, { jobId: 'job-bundle-01', to: 'postgres', stage: 'copying', startedAt: 1 });
    expect(bundleRefusal(G, 'no', 'no')).toMatch(CANT);
  });

  it('an unfinished journal after a restart refuses no import', () => {
    writeJson(JOURNAL, { jobId: 'job-bundle-02', to: 'postgres', stage: 'copying', startedAt: 1 });
    expect(bundleRefusal(G, 'no', 'no')).toBeNull();
  });
});

describe('importBundle', () => {
  async function bundle(): Promise<string> {
    seedFile(`${G}/mod/a.json`, '{"a":1}');
    const out = path.join(root, '..', `nb3-bundle-${process.pid}-${Date.now()}.dbex`);
    await writeBundle(G, out);
    return out;
  }

  it('refuses when the journal changed between its check and its swap', async () => {
    const file = await bundle();
    fs.writeFileSync(path.join(root, G, 'mod', 'a.json'), '{"a":"live"}');
    const real = fs.promises.writeFile;
    let once = false;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (!once && String(p).includes('.bundle-import-')) {
        once = true;
        writeJson(JOURNAL, { jobId: 'job-bundle-03', to: 'postgres', stage: 'checking', startedAt: 1 });
      }
      return (real as any)(p, ...rest);
    }) as any);
    await expect(importBundle(file)).rejects.toThrow(/migration/);
    expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf-8')).toBe('{"a":"live"}');
    fs.rmSync(file, { force: true });
  });

  it('refuses when the marker changed between its check and its swap', async () => {
    const file = await bundle();
    const real = fs.promises.writeFile;
    let once = false;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (!once && String(p).includes('.bundle-import-')) {
        once = true;
        writeJson(MARKER, { live: 'postgres', storeId: 'x', flippedAt: 2 });
      }
      return (real as any)(p, ...rest);
    }) as any);
    await expect(importBundle(file)).rejects.toThrow(/migration/);
    fs.rmSync(file, { force: true });
  });
});

describe('the job and a bundle import', () => {
  it('refuses while a .bundle-import-* folder exists at S2', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    fs.mkdirSync(path.join(root, `.bundle-import-${G}-1`));
    const service = serviceFor(new FakeDb(), new FakeHost());
    await service.post({ jobId: 'job-bundle-04', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'failed', stage: 'checking' });
    expect(service.status().body.job.error).toContain('.bundle-import-');
  });

  it('ends interrupted at switching when one appears before the marker', async () => {
    seedFile(`${G}/mod/a.json`, '{}');
    const db = new FakeDb();
    const service = serviceFor(db, new FakeHost(), {
      fault: point => { if (point === 'S10') fs.mkdirSync(path.join(root, `.bundle-import-${G}-2`)); },
    });
    await service.post({ jobId: 'job-bundle-05', to: 'postgres' });
    await service.idle();
    expect(service.status().body.job).toMatchObject({ state: 'interrupted', stage: 'switching' });
    expect(JSON.parse(fs.readFileSync(MARKER, 'utf-8')).live).toBe('file');
    void emptyStore;
  });
});
