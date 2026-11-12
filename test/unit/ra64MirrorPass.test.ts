import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import {
  applySharedKeys, bootShared, runSharedPass, setSharedModulePassStep, startSharedPass, stopSharedPass,
} from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';
import { mirrorRig, T11, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// L5 run A, chunk 64: sharedMirror.ts's pass on a Postgres bot (NB6 decisions 21, 29, 49; R5-B1), over the real
// PostgresBackend and helpers/sharedRows.ts's tables.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('ra64');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const LOCK = "SELECT now() AS now, pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))";
const ROOT_CONFIG = () => dataPath('dist', 'bot', 'config.json');
const STRAY = () => dataPath('Stryker was here');

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function within(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await pause(5);
  }
  return cond();
}

/** Every sharedSelect the pass sends: its text and values. */
function selects() {
  const backend = m.state.pg.backend;
  const real = backend.sharedSelect.bind(backend);
  const calls: Array<{ text: string; values: unknown[] }> = [];
  vi.spyOn(backend, 'sharedSelect').mockImplementation((t: string, values: unknown[], boundMs: number) => {
    calls.push({ text: t, values });
    return real(t, values, boundMs);
  });
  return calls;
}

const lines = (start: string) => m.state.lines.filter(l => l.startsWith(start));
const STOPPED = '[Shared] The pass over the shared files stopped';
const fsError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${code}: failed`), { code, ...extra });

function cleanExtras(): void {
  fs.rmSync(ROOT_CONFIG(), { force: true });
  fs.rmSync(STRAY(), { force: true });
  fs.rmSync(dataPath('ra64-real-global'), { recursive: true, force: true });
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
}

beforeEach(async () => {
  await m.setup();
  cleanExtras();
});
afterEach(async () => {
  _setListenClientFactory(null);
  await m.teardown();
  cleanExtras();
});

describe('ra64: the keys a full pass visits', () => {
  it('a file in the data root outside the shared set is left where it is', async () => {
    fs.writeFileSync(STRAY(), 'not a shared file');
    const res = await runSharedPass();
    expect(res).toEqual({ answered: true, cause: null });
    expect(fs.readFileSync(STRAY(), 'utf8')).toBe('not a shared file');
    expect(m.superseded()).toEqual({});
    expect(lines('[Shared] Moved')).toEqual([]);
  });

  it('a shared file under a folder named like a local file is moved aside when the database holds none', async () => {
    const file = dataPath('global', 'metrics', 'totals.json', 'a.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"stray":1}');
    await runSharedPass();
    expect(fs.existsSync(file)).toBe(false);
    expect(Object.values(m.superseded())).toEqual(['{"stray":1}']);
    expect(lines(`[Shared] Moved ${file} to `).filter(l => l.endsWith(T11.noRow))).toHaveLength(1);
  });

  it('the shared files are found through a /data/global that is a link to a folder', async () => {
    const real = dataPath('ra64-real-global');
    fs.mkdirSync(path.join(real, 'ra64'), { recursive: true });
    fs.writeFileSync(path.join(real, 'ra64', 'j.json'), '{"j":1}');
    fs.symlinkSync(real, dataPath('global'), 'junction');
    await runSharedPass();
    expect(fs.existsSync(path.join(real, 'ra64', 'j.json'))).toBe(false);
    expect(Object.values(m.superseded())).toEqual(['{"j":1}']);
  });

  it('a root config the database does not hold is moved aside', async () => {
    fs.mkdirSync(path.dirname(ROOT_CONFIG()), { recursive: true });
    fs.writeFileSync(ROOT_CONFIG(), '{"prefix":"?"}');
    await runSharedPass();
    expect(fs.existsSync(ROOT_CONFIG())).toBe(false);
    expect(m.superseded()).toEqual({ [Object.keys(m.superseded())[0]]: '{"prefix":"?"}' });
    expect(Object.keys(m.superseded())[0]).toMatch(/\/config\.json$/);
    expect(lines(`[Shared] Moved ${ROOT_CONFIG()} to `).filter(l => l.endsWith(T11.noRow))).toHaveLength(1);
  });

  it("a row keyed global/appstore is no doc and no store doc: no file is written for it", async () => {
    m.state.rows.put('global/appstore', '{"odd":1}');
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(fs.existsSync(dataPath('global', 'appstore'))).toBe(false);
  });

  it('an entry of the doc record whose row and mirror are both gone is dropped', async () => {
    await m.landed('gone.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('gone.json'));
    fs.unlinkSync(m.file('gone.json'));
    expect(m.entry('gone.json')).toBeDefined();
    await runSharedPass();
    expect(m.entry('gone.json')).toBeUndefined();
  });

  it('an entry of the store record whose row and mirror are both gone is dropped', async () => {
    const key = 'global/appstore/gone.json';
    writeStoreRecord({ docs: { [key]: { sha: sha('{"v":1}'), stamp: null, main: null } }, modules: {} });
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    const read = readStoreRecord();
    expect(read.ok && read.record.docs[key]).toBe(undefined);
  });

  it('applies doc keys in key order', async () => {
    m.state.rows.put(m.keyOf('b.json'), '{"b":1}');
    m.state.rows.put(m.keyOf('a.json'), '{"a":1}');
    const calls = selects();
    await runSharedPass();
    expect(calls.filter(c => c.text === BODY).map(c => c.values[0])).toEqual([m.keyOf('a.json'), m.keyOf('b.json')]);
  });

  it('applies App Store keys in key order', async () => {
    m.state.rows.put('global/appstore/b.json', '{"b":1}');
    m.state.rows.put('global/appstore/a.json', '{"a":1}');
    const calls = selects();
    await runSharedPass();
    expect(calls.filter(c => c.text === BODY).map(c => c.values[0])).toEqual(['global/appstore/a.json', 'global/appstore/b.json']);
    expect(fs.readFileSync(dataPath('global', 'appstore', 'a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('the listing is sent with no parameters', async () => {
    const calls = selects();
    await runSharedPass();
    const listing = calls.filter(c => c.text === LIST);
    expect(listing).toHaveLength(1);
    expect(listing[0].values).toEqual([]);
  });
});

describe('ra64: T11 lines and the write log', () => {
  it('a changed mirror whose row went before its body read is moved aside with the no-row line', async () => {
    await m.landed('k.json', { v: 1 });
    fs.writeFileSync(m.file('k.json'), text({ v: 'edited by hand, longer' }));
    m.state.rows.fault = (sql, params) => {
      if (sql === BODY && params?.[0] === m.keyOf('k.json')) m.state.rows.docs.delete(m.keyOf('k.json'));
      return undefined;
    };
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(fs.existsSync(m.file('k.json'))).toBe(false);
    expect(Object.values(m.superseded())).toEqual([text({ v: 'edited by hand, longer' })]);
    const moved = lines(`[Shared] Moved ${m.file('k.json')} to `);
    expect(moved).toHaveLength(1);
    expect(moved[0].endsWith(`); ${T11.noRow}`)).toBe(true);
    expect(m.entry('k.json')).toBeUndefined();
  });

  it('a failed mirror write is logged again after a write of that file succeeded', async () => {
    const key = m.keyOf('w.json');
    const dir = path.dirname(m.file('w.json'));
    let failing = true;
    const realMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (p: fs.PathLike, o?: any) => {
      if (failing && path.resolve(String(p)) === path.resolve(dir)) throw fsError('EACCES');
      return realMkdir(p, o);
    }) as never);
    const failed = () => lines(`[Shared] Could not write ${m.file('w.json')} (EACCES); retrying`);
    m.state.rows.put(key, text({ v: 1 }));
    await runSharedPass();
    expect(failed()).toHaveLength(1);
    expect(m.read('w.json')).toBeNull();
    failing = false;
    await runSharedPass();
    expect(m.read('w.json')).toBe(text({ v: 1 }));
    failing = true;
    m.state.rows.put(key, text({ v: 2 }));
    await runSharedPass();
    expect(m.read('w.json')).toBe(text({ v: 1 }));
    expect(failed()).toHaveLength(2);
  });
});

describe("ra64: the pass boundary's answer and its line", () => {
  let step: () => Promise<boolean | { cause: string }>;
  beforeEach(() => {
    step = async () => true;
    setSharedModulePassStep(() => step());
  });

  it('an error with a path is this machine\'s own', async () => {
    const error = fsError('EACCES', { path: '/data/global/x.json', syscall: 'open' });
    step = async () => { throw error; };
    expect(await runSharedPass()).toEqual({ answered: false, cause: error.message, local: true });
  });

  it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EIO'])('an fd error %s with no path is this machine\'s own', async code => {
    const error = fsError(code, { syscall: 'write' });
    step = async () => { throw error; };
    expect(await runSharedPass()).toEqual({ answered: false, cause: error.message, local: true });
  });

  it('an error that is not this machine\'s is answered without the local mark', async () => {
    const error = fsError('ECONNRESET', { syscall: 'read' });
    step = async () => { throw error; };
    expect(await runSharedPass()).toEqual({ answered: false, cause: error.message });
  });

  it.each([undefined, null])('a thrown %s is answered, not rejected', async thrown => {
    step = async () => { throw thrown; };
    expect(await runSharedPass()).toEqual({ answered: false, cause: String(thrown) });
    expect(lines(STOPPED)).toEqual([`${STOPPED} (${String(thrown)}); it tries again at the next pass`]);
  });

  it('two local errors of different codes are each logged', async () => {
    step = async () => { throw fsError('EIO', { syscall: 'write' }); };
    await runSharedPass();
    step = async () => { throw fsError('ENOSPC', { syscall: 'write' }); };
    await runSharedPass();
    expect(lines(STOPPED)).toEqual([
      `${STOPPED} (EIO: failed); it tries again at the next pass`,
      `${STOPPED} (ENOSPC: failed); it tries again at the next pass`,
    ]);
  });

  it('a pass that is not answered keeps the line from being logged again', async () => {
    step = async () => { throw new Error('boom'); };
    await runSharedPass();
    step = async () => false;
    expect((await runSharedPass()).answered).toBe(false);
    step = async () => { throw new Error('boom'); };
    await runSharedPass();
    expect(lines(STOPPED)).toHaveLength(1);
  });

  it('an answered pass lets the same line be logged again', async () => {
    step = async () => { throw new Error('boom'); };
    await runSharedPass();
    step = async () => true;
    expect((await runSharedPass()).answered).toBe(true);
    step = async () => { throw new Error('boom'); };
    await runSharedPass();
    expect(lines(STOPPED)).toHaveLength(2);
  });
});

describe("ra64: the listing's failure line", () => {
  const CHECK = '[Shared] Could not check the shared files against the database (boom); the next pass tries again';

  it('names the shared files', async () => {
    m.state.rows.fault = sql => (sql === LIST ? new Error('boom') : undefined);
    expect(await runSharedPass()).toEqual({ answered: false, cause: 'boom' });
    expect(m.state.lines).toContain(CHECK);
  });

  it('is logged again after a listing that answered', async () => {
    let fail = true;
    const backend = m.state.pg.backend;
    const real = backend.sharedSelect.bind(backend);
    // A rejection here, not at the pool, leaves the backend's failure latch alone, so the next listing answers.
    vi.spyOn(backend, 'sharedSelect').mockImplementation((t: string, values: unknown[], boundMs: number) => (t === LIST && fail ? Promise.reject(new Error('boom')) : real(t, values, boundMs)));
    await runSharedPass();
    fail = false;
    expect(await runSharedPass()).toEqual({ answered: true, cause: null });
    fail = true;
    await runSharedPass();
    expect(m.state.lines.filter(l => l === CHECK)).toHaveLength(2);
  });

  it("the boot's pass logs only its own waiting line", async () => {
    m.state.rows.fault = sql => (sql === LIST ? new Error('boom') : undefined);
    const boot = bootShared();
    expect(await within(() => lines('[Shared] Waiting for the database').length > 0, 2000)).toBe(true);
    stopSharedPass();
    expect(await boot).toBe('stopped');
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Could not check'))).toEqual([]);
  });
});

describe('ra64: the stop', () => {
  it('a pass for keys after the stop sends nothing', async () => {
    stopSharedPass();
    expect(await applySharedKeys([m.keyOf('s.json')])).toEqual({ answered: false, cause: null });
    expect(m.sql()).toEqual([]);
  });

  it("a stop after the listing ends the pass at once, without waiting for another apply of a key", async () => {
    const key = m.keyOf('h.json');
    m.state.rows.put(key, text({ v: 1 }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held!: () => void;
    const reached = new Promise<void>(resolve => { held = resolve; });
    let stopOnList = false;
    m.state.rows.fault = async (sql, params) => {
      if (sql === BODY && params?.[0] === key) {
        held();
        await gate;
      }
      if (sql === LIST && stopOnList) stopSharedPass();
      return undefined;
    };
    const keyed = applySharedKeys([key]);
    try {
      await reached;
      stopOnList = true;
      const res = await Promise.race([runSharedPass(), pause(1000).then(() => 'still running' as const)]);
      expect(res).toEqual({ answered: false, cause: null });
    } finally {
      release();
    }
    expect(await keyed).toEqual({ answered: false, cause: null });
    expect(m.read('h.json')).toBeNull();
  });

  it('a stop after the listing applies no App Store key and runs no module step', async () => {
    m.state.rows.put('global/appstore/s.json', '{"s":1}');
    const moduleStep = vi.fn(async () => true);
    setSharedModulePassStep(moduleStep);
    m.state.rows.fault = sql => {
      if (sql === LIST) stopSharedPass();
      return undefined;
    };
    expect(await runSharedPass()).toEqual({ answered: false, cause: null });
    expect(fs.existsSync(dataPath('global', 'appstore', 's.json'))).toBe(false);
    expect(moduleStep).not.toHaveBeenCalled();
  });
});

describe('ra64: a root config op in flight during a pass', () => {
  it('is not applied again once it lands, as the pass never visited it', async () => {
    const rig = listenRig();
    for (let i = 0; i < 20; i++) rig.plan.push(new Error('connect ECONNREFUSED'));
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let holding = true;
    m.state.rows.fault = async sql => {
      if (holding && sql === LOCK) await gate;
      return undefined;
    };
    const calls = selects();
    fs.mkdirSync(path.dirname(ROOT_CONFIG()), { recursive: true });
    expect(dm.writeRawAtomicTracked(ROOT_CONFIG(), '{"a":1}')).toEqual({ accepted: true });
    expect(rowQueue.ops('config.json')).toHaveLength(1);
    expect(fs.existsSync(ROOT_CONFIG())).toBe(false);
    try {
      expect((await runSharedPass()).answered).toBe(true);
      expect(rowQueue.ops('config.json')).toHaveLength(1);
    } finally {
      holding = false;
      release();
    }
    expect(await within(() => rowQueue.ops('config.json').length === 0, 5000)).toBe(true);
    expect(await within(() => calls.some(c => c.text === LIST_KEYS), 300)).toBe(false);
  });
});
