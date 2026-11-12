import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listen = vi.hoisted(() => ({ deps: null as null | { onDoc(key: string): void; onModule?(module: string): void } }));

vi.mock('../../src/bot/internalSetup/utils/sharedListener', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    startSharedListener: (deps: { onDoc(key: string): void; onModule?(module: string): void }) => { listen.deps = deps; },
    stopSharedListener: () => undefined,
  };
});

import { dataPath } from '../../src/utils/dataRoot';
import { writeDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { withMirrorLock } from '../../src/bot/internalSetup/utils/sharedStore';
import {
  _resetSharedMirror, applySharedKeys, refreshShared, runSharedPass, runStoreDocsPass, setSharedModulePassStep, startSharedPass,
  type ModulePassStep,
} from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { mirrorRig } from '../helpers/nb6Mirror';
import { lost, sha } from '../helpers/sharedRows';

const rig = mirrorRig('rd3');
const KEY = rig.keyOf('a.json');
const FILE = rig.file('a.json');
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const READ_LINE = '[Shared] Could not check the shared files against the database (';

interface Call { modules?: string[]; rehash: boolean }
let calls: Call[] = [];
let behave: (call: Call) => Promise<boolean | { cause: string }> = async () => true;
const step: ModulePassStep = async p => {
  const call = { modules: p.modules, rehash: p.rehash };
  calls.push(call);
  return behave(call);
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const moduleCalls = (name?: string) => calls.filter(c => c.modules !== undefined && (name === undefined || c.modules.includes(name)));
const fullCalls = () => calls.filter(c => c.modules === undefined);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const notice = (module: string) => listen.deps!.onModule!(module);
const keyLists = () => rig.state.pg.sent.filter(s => s.sql === LIST_KEYS).length;

function startWithStep(): void {
  setSharedModulePassStep(step);
  startSharedPass();
  expect(listen.deps?.onModule).toBeTypeOf('function');
}

/** A mirror holding X whose entry names Y's sha with the file's own stamp: only a rehash reads its bytes. */
function stampedMirror(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, 'X');
  rig.state.rows.put(KEY, 'Y');
  const st = fs.lstatSync(FILE);
  writeDocRecord({ docs: { [KEY]: { sha: sha('Y'), stamp: `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`, main: null } } });
}

beforeEach(async () => {
  listen.deps = null;
  calls = [];
  behave = async () => true;
  await rig.setup();
});
afterEach(() => rig.teardown());

describe('rehash and quiet of each pass entry', () => {
  it("runSharedPass trusts a matching stamp and reads the bytes only when asked to rehash", async () => {
    setSharedModulePassStep(step);
    stampedMirror();
    await expect(runSharedPass()).resolves.toMatchObject({ answered: true });
    expect(rig.read('a.json')).toBe('X');
    expect(fullCalls().map(c => c.rehash)).toEqual([false]);
    await expect(runSharedPass({ rehash: true })).resolves.toMatchObject({ answered: true });
    expect(rig.read('a.json')).toBe('Y');
    expect(Object.values(rig.superseded())).toEqual(['X']);
    expect(fullCalls().map(c => c.rehash)).toEqual([false, true]);
  });

  it('applySharedKeys trusts a matching stamp: the mirror is left as it is', async () => {
    stampedMirror();
    await expect(applySharedKeys([KEY])).resolves.toEqual({ answered: true, cause: null });
    expect(rig.read('a.json')).toBe('X');
    expect(rig.superseded()).toEqual({});
  });

  it('refreshShared trusts a matching stamp: the mirror is left as it is', async () => {
    stampedMirror();
    await expect(refreshShared([KEY])).resolves.toEqual({ ok: true });
    expect(rig.read('a.json')).toBe('X');
    expect(rig.superseded()).toEqual({});
  });

  it("applySharedKeys logs a failed listing read", async () => {
    rig.state.rows.fault = sql => (sql === LIST_KEYS ? lost() : undefined);
    const res = await applySharedKeys([KEY]);
    expect(res.answered).toBe(false);
    expect(rig.state.lines.filter(l => l.startsWith(READ_LINE))).toHaveLength(1);
  });

  it("refreshShared logs a failed listing read", async () => {
    rig.state.rows.fault = sql => (sql === LIST_KEYS ? lost() : undefined);
    const res = await refreshShared([KEY]);
    expect(res.ok).toBe(false);
    expect(rig.state.lines.filter(l => l.startsWith(READ_LINE))).toHaveLength(1);
  });
});

describe('refreshShared on a JSON bot and its bound', () => {
  it('a JSON bot answers ok and reads nothing from the database', async () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, 'X');
    rig.state.rows.put(KEY, 'Y');
    setBackendKind('file');
    await expect(refreshShared([KEY])).resolves.toEqual({ ok: true });
    expect(rig.read('a.json')).toBe('X');
    expect(rig.sql()).toEqual([]);
  });

  it('leaves no bound timer pending once it answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await expect(refreshShared([KEY])).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("another process's doc notices (decision 10)", () => {
  it('a notice after an apply ended applies the key again', async () => {
    startWithStep();
    rig.state.rows.put(KEY, 'v1');
    listen.deps!.onDoc(KEY);
    await vi.waitFor(() => expect(rig.read('a.json')).toBe('v1'), { timeout: 1000 });
    await tick();
    rig.state.rows.put(KEY, 'v2');
    listen.deps!.onDoc(KEY);
    await vi.waitFor(() => expect(rig.read('a.json')).toBe('v2'), { timeout: 1000 });
  });

  it('notices during an apply run one more apply after it, which takes the newer row', async () => {
    startWithStep();
    rig.state.rows.put(KEY, 'v1');
    const hold = deferred();
    const locked = deferred();
    const lock = withMirrorLock(KEY, async () => { locked.resolve(); await hold.promise; });
    await locked.promise;
    listen.deps!.onDoc(KEY);
    await vi.waitFor(() => expect(rig.state.pg.sent.some(s => s.sql.startsWith('SELECT body, sha'))).toBe(true), { timeout: 1000 });
    rig.state.rows.put(KEY, 'v2');
    listen.deps!.onDoc(KEY);
    listen.deps!.onDoc(KEY);
    listen.deps!.onDoc(KEY);
    await tick();
    hold.resolve();
    await lock;
    await vi.waitFor(() => expect(rig.read('a.json')).toBe('v2'), { timeout: 1000 });
    await tick();
    await tick();
    expect(keyLists()).toBe(2);
  });
});

describe("another machine's module notices", () => {
  it("runs the module step for that module, not as a rehash", async () => {
    startWithStep();
    notice('m');
    await vi.waitFor(() => expect(moduleCalls('m')).toHaveLength(1), { timeout: 1000 });
    expect(moduleCalls('m')[0]).toEqual({ modules: ['m'], rehash: false });
  });

  it('notices during a module run run the step once more after it', async () => {
    startWithStep();
    const first = deferred();
    behave = async c => {
      if (moduleCalls().length === 1 && c.modules) await first.promise;
      return true;
    };
    notice('m');
    expect(moduleCalls('m')).toHaveLength(1);
    notice('m');
    notice('m');
    notice('m');
    await tick();
    expect(moduleCalls('m')).toHaveLength(1);
    first.resolve();
    await vi.waitFor(() => expect(moduleCalls('m').length).toBeGreaterThanOrEqual(2), { timeout: 1000 });
    await runSharedPass();
    await runSharedPass();
    expect(moduleCalls('m')).toHaveLength(2);
  });

  it('a notice after a module run ended runs the step again', async () => {
    startWithStep();
    notice('m');
    await vi.waitFor(() => expect(moduleCalls('m')).toHaveLength(1), { timeout: 1000 });
    await tick();
    notice('m');
    await vi.waitFor(() => expect(moduleCalls('m')).toHaveLength(2), { timeout: 1000 });
  });

  it('a module notice waits for a running pass', async () => {
    startWithStep();
    const full = deferred();
    const order: string[] = [];
    behave = async c => {
      if (!c.modules) {
        order.push('full-start');
        await full.promise;
        order.push('full-end');
      } else {
        order.push('module');
      }
      return true;
    };
    const run = runSharedPass();
    await vi.waitFor(() => expect(order).toEqual(['full-start']), { timeout: 1000 });
    notice('m');
    expect(moduleCalls()).toHaveLength(0);
    full.resolve();
    await run;
    await vi.waitFor(() => expect(order).toEqual(['full-start', 'full-end', 'module']), { timeout: 1000 });
  });

  it('a module run holds off a second run of the same module until it ends', async () => {
    startWithStep();
    const first = deferred();
    behave = async c => {
      if (c.modules && moduleCalls().length === 1) await first.promise;
      return true;
    };
    notice('m');
    expect(moduleCalls('m')).toHaveLength(1);
    await tick();
    await tick();
    notice('m');
    expect(moduleCalls('m')).toHaveLength(1);
    first.resolve();
    await vi.waitFor(() => expect(moduleCalls('m')).toHaveLength(2), { timeout: 1000 });
  });

  it("the minute's pass runs after a module run ended", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    startWithStep();
    notice('m');
    await vi.waitFor(() => expect(moduleCalls('m')).toHaveLength(1), { timeout: 1000 });
    await tick();
    await tick();
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(fullCalls()).toHaveLength(1), { timeout: 1000 });
  });
});

describe('a pass started after the reset is not released by a run from before it', () => {
  it('a full pass from before the reset leaves the module run after it in place', async () => {
    setSharedModulePassStep(step);
    const old = deferred();
    const mod = deferred();
    behave = async c => {
      if (!c.modules) await old.promise;
      else if (c.modules.includes('m')) await mod.promise;
      return true;
    };
    const before = runSharedPass();
    await vi.waitFor(() => expect(fullCalls()).toHaveLength(1), { timeout: 1000 });
    _resetSharedMirror();
    startWithStep();
    notice('m');
    expect(moduleCalls('m')).toHaveLength(1);
    old.resolve();
    await before;
    await tick();
    notice('x');
    expect(moduleCalls('x')).toHaveLength(0);
    mod.resolve();
    await vi.waitFor(() => expect(moduleCalls('x')).toHaveLength(1), { timeout: 1000 });
  });

  it('a module run from before the reset leaves the module run after it in place', async () => {
    startWithStep();
    const old = deferred();
    const next = deferred();
    behave = async c => {
      if (c.modules?.includes('m')) await old.promise;
      else if (c.modules?.includes('n')) await next.promise;
      return true;
    };
    notice('m');
    expect(moduleCalls('m')).toHaveLength(1);
    _resetSharedMirror();
    startWithStep();
    notice('n');
    expect(moduleCalls('n')).toHaveLength(1);
    old.resolve();
    await tick();
    await tick();
    notice('x');
    expect(moduleCalls('x')).toHaveLength(0);
    next.resolve();
    await vi.waitFor(() => expect(moduleCalls('x')).toHaveLength(1), { timeout: 1000 });
  });
});

describe("a module run's answer clears the pass's stop lines", () => {
  const STOP = '[Shared] The pass over the shared files stopped (boom)';
  const stops = () => rig.state.lines.filter(l => l.startsWith(STOP)).length;

  async function runModule(name: string, answer: 'throw' | true | { cause: string }): Promise<void> {
    behave = async c => {
      if (c.modules?.includes(name) && answer === 'throw') throw new Error('boom');
      return c.modules?.includes(name) ? answer as true | { cause: string } : true;
    };
    const n = moduleCalls(name).length;
    notice(name);
    await vi.waitFor(() => expect(moduleCalls(name)).toHaveLength(n + 1), { timeout: 1000 });
    await tick();
    await tick();
  }

  it('an answered module run logs a later stop again', async () => {
    startWithStep();
    await runModule('a', 'throw');
    expect(stops()).toBe(1);
    await runModule('b', true);
    await runModule('c', 'throw');
    expect(stops()).toBe(2);
  });

  it('an unanswered module run does not', async () => {
    startWithStep();
    await runModule('a', 'throw');
    expect(stops()).toBe(1);
    await runModule('b', { cause: 'the module rows did not answer' });
    await runModule('c', 'throw');
    expect(moduleCalls('c')).toHaveLength(1);
    expect(stops()).toBe(1);
  });
});

describe("the web UI's pass of the App Store docs (decision 31)", () => {
  it("moves aside a store doc file that is in neither the record nor the rows", async () => {
    const file = dataPath('global', 'appstore', 'installed.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"modules":{}}');
    await expect(runStoreDocsPass(fn => fn())).resolves.toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
    const moved = rig.superseded();
    expect(Object.entries(moved)).toEqual([[expect.stringMatching(/^shared-\d+\/global\/appstore\/installed\.json$/), '{"modules":{}}']]);
    expect(rig.state.lines.some(l => l.includes('the database holds no such file, so nothing was put back'))).toBe(true);
  });
});
