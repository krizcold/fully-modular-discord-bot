import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stopping: false,
  steps: [] as unknown[],
  onWrite: null as null | ((record: any) => void),
  realWrite: null as null | ((record: any) => void),
}));

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return { ...real, isStopping: () => h.stopping || real.isStopping() };
});

vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    setSharedModulePassStep: (step: Parameters<typeof real.setSharedModulePassStep>[0]) => {
      h.steps.push(step);
      real.setSharedModulePassStep(step);
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/sharedRecords', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedRecords')>();
  h.realWrite = real.writeStoreRecord;
  return {
    ...real,
    writeStoreRecord: (record: Parameters<typeof real.writeStoreRecord>[0]) => {
      const hook = h.onWrite;
      if (hook) hook(record);
      real.writeStoreRecord(record);
    },
  };
});

import fs from 'fs';
import path from 'path';
import { applyRig, fakeLoader } from '../helpers/nb6ApplyRig';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { readStoreRecord, storeRecordPath, writeStoreRecord, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { MODULE_STATUS_SQL, modulePassStep } from '../../src/bot/internalSetup/utils/moduleApply';
import { crashFilePath, startEndFailed } from '../../src/bot/internalSetup/utils/moduleCrashes';

const stepsAtLoad = [...h.steps];

const rig = applyRig();
const S_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const LIST_SQL = 'SELECT module, sha, version, updated_by FROM smdb_data.shared_modules';
const STALE_MS = 10 * 60_000;

beforeEach(() => rig.setup());
afterEach(async () => {
  h.stopping = false;
  h.onWrite = null;
  await rig.teardown();
});

const shared = () => rig.state.lines.filter(l => l.startsWith('[Shared]'));

function entryOf(sha: string, main: string | null, status: boolean): ModuleEntry {
  return {
    sha, stamp: null, files: {}, main, built: null, failedSha: null, retryAt: null, heldSha: null, applying: null,
    status: status ? { state: 'applied', sha, error: null, at: new Date().toISOString(), seq: 1 } : null,
  };
}

function writeModules(modules: Record<string, ModuleEntry | null>): void {
  fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
  fs.writeFileSync(storeRecordPath(), JSON.stringify({ docs: {}, modules }));
}

describe('the module step is the pass step of the shared mirror', () => {
  it('rl8 register: loading moduleApply hands modulePassStep to the shared mirror', () => {
    expect(stepsAtLoad).toContain(modulePassStep);
  });
});

describe('staged folders left by a crash', () => {
  it('rl8 staged age: one exactly 10 minutes old stays, one a millisecond older is deleted with its files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now);
    const kept = rig.writeTree(path.join(rig.state.source, `.incoming-m-${now - STALE_MS}`), { 'index.js': 'kept' });
    const gone = rig.writeTree(path.join(rig.state.source, `.incoming-n-${now - STALE_MS - 1}`), { 'index.js': 'gone', 'sub/a.js': 'a' });
    await expect(rig.pass()).resolves.toBe(true);
    expect(rig.readTree(kept)).toEqual({ 'index.js': 'kept' });
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('rl8 no source root: a pass with no source modules folder answers true', async () => {
    fs.rmSync(rig.state.source, { recursive: true, force: true });
    await expect(rig.pass()).resolves.toBe(true);
  });
});

describe('what the module step answers', () => {
  it('rl8 no backend: with no row backend the step answers false', async () => {
    dm.setGuildDataBackend(null);
    await expect(modulePassStep({ tag0: '1:ALPHA' })).resolves.toBe(false);
  });

  it('rl8 listing binds: the listing sends no bind values, which Postgres would refuse for a query with no placeholder', async () => {
    await rig.publish('m', S_FILES);
    await expect(rig.pass()).resolves.toBe(true);
    const lists = rig.state.pg.sent.filter(s => s.sql === LIST_SQL);
    expect(lists.length).toBeGreaterThan(0);
    for (const s of lists) {
      const values = s.params ?? (s.raw as { values?: unknown[] })?.values ?? [];
      expect(values).toEqual([]);
    }
    expect(rig.entry('m')?.sha).not.toBe('absent');
  });

  it('rl8 unreadable record: a store record that is not JSON answers true and touches no module', async () => {
    const s = await rig.publish('m', S_FILES);
    fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
    fs.writeFileSync(storeRecordPath(), 'not json');
    await expect(rig.pass()).resolves.toBe(true);
    expect(fakeLoader.loads).toEqual([]);
    expect(fs.readFileSync(storeRecordPath(), 'utf8')).toBe('not json');
    expect(s).toBeTruthy();
  });

  it('rl8 null entry: an entry stored as null is passed over and the step answers true', async () => {
    writeModules({ m: null });
    await expect(rig.pass()).resolves.toBe(true);
  });

  it('rl8 stopping: a stop begun before the first module answers true and applies nothing', async () => {
    await rig.publish('m', S_FILES);
    h.stopping = true;
    await expect(rig.pass()).resolves.toBe(true);
    expect(fakeLoader.loads).toEqual([]);
    expect(rig.live('m')).toBeNull();
    expect(rig.entry('m')).toBeUndefined();
  });
});

describe("step 0: a status of another main's entry", () => {
  it('rl8 entry gone: an entry deleted while an earlier status was sent is not written back, and the step answers true', async () => {
    writeModules({ a: entryOf('sa', '1:ALPHA', true), b: entryOf('sb', '0:OLD', true) });
    const backend = rig.state.pg.backend as unknown as { sharedTx: (spec: any) => Promise<unknown> };
    const real = backend.sharedTx.bind(backend);
    vi.spyOn(backend, 'sharedTx').mockImplementation(async (spec: any) => {
      if (spec.check === null && spec.statements(null)[0]?.text === MODULE_STATUS_SQL) {
        const read = readStoreRecord();
        if (!read.ok) throw new Error(read.reason);
        delete read.record.modules.b;
        writeStoreRecord(read.record);
      }
      return real(spec);
    });
    await expect(modulePassStep({ tag0: '1:ALPHA', modules: [] })).resolves.toBe(true);
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    expect(Object.keys(read.record.modules)).toEqual(['a']);
  });
});

describe('the order of the modules', () => {
  it('rl8 sorted: modules are applied in name order, whatever order the rows come in', async () => {
    await rig.publish('b', { ...S_FILES, 'module.json': '{"name":"b","version":"1.0.0"}' });
    await rig.publish('a', { ...S_FILES, 'module.json': '{"name":"a","version":"1.0.0"}' });
    await expect(rig.pass()).resolves.toBe(true);
    expect(fakeLoader.loads.map(l => l.module)).toEqual(['a', 'b']);
  });
});

describe('the log of a module whose pass threw', () => {
  async function throwOnAdopt(before?: (record: any, sha: string) => void): Promise<void> {
    const s = await rig.publish('m', S_FILES);
    rig.writeTree(path.join(rig.state.source, 'm'), S_FILES);
    h.onWrite = record => {
      if (record.modules?.m?.sha !== s || record.modules.m.applying) return;
      h.onWrite = null;
      before?.(record, s);
      throw new Error('disk full');
    };
    await expect(rig.pass()).resolves.toBe(true);
  }

  it('rl8 tail pass: with no start pending and no retry time, the next pass tries again', async () => {
    await throwOnAdopt();
    expect(shared()).toContain('[Shared] Could not bring the module m up to date (disk full); the next pass tries again');
  });

  it("rl8 tail start: a start that failed to end names the bot's next start", async () => {
    await throwOnAdopt((record, s) => {
      const applying = { from: 'absent', to: s, backup: null, displaced: 'backups', tag: '1:ALPHA', version: '1.0.0', updatedBy: null };
      h.realWrite!({ ...record, modules: { ...record.modules, m: { ...record.modules.m, applying } } });
      startEndFailed({ module: 'm' }, new Error('crash file locked'));
    });
    expect(shared()).toContain("[Shared] Could not bring the module m up to date (disk full); this machine applies the database's current version of m after the bot's next start");
  });
});

describe('step 7: the crash lines', () => {
  const writeCrash = () => {
    fs.mkdirSync(path.dirname(crashFilePath()), { recursive: true });
    fs.writeFileSync(crashFilePath(), JSON.stringify({ z: { sha: 'sz', n: 1 } }));
  };
  const crash = () => JSON.parse(fs.readFileSync(crashFilePath(), 'utf8'));

  it('rl8 other main: a pass of a main that is no longer the main keeps every crash line', async () => {
    writeCrash();
    await expect(modulePassStep({ tag0: '2:BRAVO' })).resolves.toBe(true);
    expect(crash()).toEqual({ z: { sha: 'sz', n: 1 } });
  });

  it("rl8 this main: a pass of the main drops a crash line no row or entry names", async () => {
    writeCrash();
    await expect(rig.pass()).resolves.toBe(true);
    expect(crash()).toEqual({});
  });
});
