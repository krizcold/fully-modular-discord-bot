import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot's pass (bootShared, sharedBootDone, sharedBootCause, sharedBootCauseLocal) and the bot's pass of the App
// Store keys under the store mutex (NB6 decisions 14 and 31, R5-B2), through the real pass over scripted pg.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { storeRecordPath, writeDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { useStoreLanding } from '../../src/bot/internalSetup/utils/sharedStore';
import {
  bootShared, runSharedPass, setSharedLinesPassStep, setSharedModulePassStep, sharedBootCause, sharedBootCauseLocal,
  sharedBootDone, stopSharedPass, type ModulePassStep,
} from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { mirrorRig } from '../helpers/nb6Mirror';
import { lost, pgError, sha } from '../helpers/sharedRows';

const rig = mirrorRig('re5boot');
const KEY = rig.keyOf('a.json');
const FILE = rig.file('a.json');
const STORE_KEY = 'global/appstore/re5.json';
const STORE_FILE = dataPath('global', 'appstore', 're5.json');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const READ_LINE = '[Shared] Could not check the shared files against the database (';
const WAIT_DB = '[Shared] Waiting for the database to bring the shared files up to date (';
const WAIT_LOCAL = '[Shared] Waiting for this machine to write the shared files (';
const waits = () => rig.state.lines.filter(l => l.startsWith('[Shared] Waiting for '));

let steps: Array<() => Promise<boolean | { cause: string }>>;
let stepCalls: number;
const step: ModulePassStep = async () => {
  const next = steps[Math.min(stepCalls, steps.length - 1)];
  stepCalls += 1;
  return next();
};
const fsFailure = () => Object.assign(new Error("EACCES: permission denied, open '/data/modules/m/x.js'"), { code: 'EACCES', syscall: 'open', path: '/data/modules/m/x.js' });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function readStore(): string | null {
  try {
    return fs.readFileSync(STORE_FILE, 'utf8');
  } catch {
    return null;
  }
}

beforeEach(async () => {
  steps = [async () => true];
  stepCalls = 0;
  await rig.setup();
  setSharedModulePassStep(step);
});

afterEach(async () => {
  setSharedLinesPassStep(null);
  setSharedModulePassStep(null);
  useStoreLanding(null);
  await rig.teardown();
});

describe('bootShared on a process with no Postgres backend', () => {
  it('ends done and marks the boot done, so the child serves shared ops', async () => {
    dm.setGuildDataBackend(null);
    setBackendKind('postgres');
    await expect(bootShared()).resolves.toBe('done');
    expect(sharedBootDone()).toBe(true);
    expect(rig.sql()).toEqual([]);
  });
});

describe("the boot's pass", () => {
  it('reads every mirror\'s bytes: a mirror whose stamp matches its entry but whose bytes differ gets the row back', async () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, 'X');
    rig.state.rows.put(KEY, 'Y');
    const st = fs.lstatSync(FILE);
    writeDocRecord({ docs: { [KEY]: { sha: sha('Y'), stamp: `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`, main: null } } });
    await expect(bootShared()).resolves.toBe('done');
    expect(rig.read('a.json')).toBe('Y');
    expect(Object.values(rig.superseded())).toEqual(['X']);
  });

  it("is quiet about a failed listing: only the boot's own waiting line is logged", async () => {
    rig.state.rows.fault = sql => (sql === LIST ? lost() : undefined);
    const boot = bootShared();
    await vi.waitFor(() => expect(waits()).toHaveLength(1), { timeout: 5000 });
    expect(rig.state.lines.filter(l => l.startsWith(READ_LINE))).toEqual([]);
    stopSharedPass();
    await expect(boot).resolves.toBe('stopped');
  });

  it('a stop during an answered try ends the boot stopped, not done', async () => {
    setSharedLinesPassStep(async () => {
      stopSharedPass();
      return { ok: true };
    });
    await expect(bootShared()).resolves.toBe('stopped');
    expect(sharedBootDone()).toBe(false);
  });

  it("a stop during the 5 s wait leaves no retry timer pending", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    steps = [async () => { throw new Error('boom'); }];
    const boot = bootShared();
    await vi.advanceTimersByTimeAsync(0);
    expect(waits()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    stopSharedPass();
    await expect(boot).resolves.toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the boot's cause and whether it is this machine's", () => {
  it('a later boot whose try fails with no cause logs the database form, not the local one', async () => {
    await expect(bootShared()).resolves.toBe('done');
    steps = [async () => false];
    stepCalls = 0;
    const boot = bootShared();
    await vi.waitFor(() => expect(waits()).toHaveLength(1), { timeout: 5000 });
    expect(waits()[0].startsWith(WAIT_DB)).toBe(true);
    stopSharedPass();
    await expect(boot).resolves.toBe('stopped');
  });

  it("a try that ends with no cause keeps the earlier try's local form in the boot's line", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    steps = [async () => { throw fsFailure(); }, async () => false];
    const boot = bootShared();
    await vi.advanceTimersByTimeAsync(0);
    expect(waits()).toHaveLength(1);
    expect(waits()[0].startsWith(WAIT_LOCAL)).toBe(true);
    expect(sharedBootCauseLocal()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stepCalls).toBeGreaterThan(2);
    expect(waits()).toHaveLength(2);
    expect(waits()[1].startsWith(WAIT_LOCAL)).toBe(true);
    stopSharedPass();
    await vi.advanceTimersByTimeAsync(0);
    await expect(boot).resolves.toBe('stopped');
  });

  it("once a boot ended done, a later boot's local failure is not reported as the boot's cause", async () => {
    await expect(bootShared()).resolves.toBe('done');
    steps = [async () => { throw fsFailure(); }];
    stepCalls = 0;
    const boot = bootShared();
    await vi.waitFor(() => expect(waits()).toHaveLength(1), { timeout: 5000 });
    expect(waits()[0].startsWith(WAIT_LOCAL)).toBe(true);
    expect(sharedBootCause()).toBeNull();
    expect(sharedBootCauseLocal()).toBe(false);
    stopSharedPass();
    await expect(boot).resolves.toBe('stopped');
  });

  it('a try whose listing answered clears the cause: it is no longer called local', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const held = deferred();
    steps = [async () => { throw fsFailure(); }, async () => { await held.promise; return true; }];
    const boot = bootShared();
    await vi.advanceTimersByTimeAsync(0);
    expect(sharedBootCauseLocal()).toBe(true);
    expect(sharedBootCause()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(stepCalls).toBe(2);
    expect(sharedBootCause()).toBeNull();
    expect(sharedBootCauseLocal()).toBe(false);
    held.resolve();
    await expect(boot).resolves.toBe('done');
  });
});

describe("the bot's pass of the App Store keys", () => {
  it('a store mutex busy past its bound leaves the App Store mirror to the next pass', async () => {
    rig.state.rows.put(STORE_KEY, 'S');
    let lockedRuns = 0;
    useStoreLanding({ acquire: async () => null, locked: <T>(fn: () => T): T => { lockedRuns += 1; return fn(); } });
    await expect(runSharedPass()).resolves.toMatchObject({ answered: true });
    expect(readStore()).toBeNull();
    expect(lockedRuns).toBe(0);
    expect(rig.sql()).not.toContain(BODY);
  });

  it("a failed read of an App Store row answers the pass unanswered with the read's cause", async () => {
    rig.state.rows.put(STORE_KEY, 'S');
    rig.state.rows.fault = sql => (sql === BODY ? pgError('57014', 'canceling statement due to statement timeout') : undefined);
    const res = await runSharedPass();
    expect(res.answered).toBe(false);
    expect(res.cause).toContain('canceling statement due to statement timeout');
    expect(res.local).toBeUndefined();
    expect(readStore()).toBeNull();
  });

  it("a failed write of the store record answers the pass unanswered, as this machine's own failure", async () => {
    rig.state.rows.put(STORE_KEY, 'S');
    const prefix = `${storeRecordPath()}.`;
    let cause = '';
    const real = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(prefix)) {
        cause = `ENOSPC: no space left on device, open '${String(p)}'`;
        throw Object.assign(new Error(cause), { errno: -28, code: 'ENOSPC', syscall: 'open', path: String(p) });
      }
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.openSync);
    const res = await runSharedPass();
    expect(cause).not.toBe('');
    expect(res).toEqual({ answered: false, cause, local: true });
    expect(readStore()).toBe('S');
  });
});
