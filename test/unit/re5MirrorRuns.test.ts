import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// startSharedPass's settle listener, timer and listener hooks, and what _resetSharedMirror leaves for the next process
// (NB6 decisions 10, 21 and 29, C25), through the real pass over scripted pg. The listener is replaced so its hooks can
// be called directly; the row queue's settle listener is the real one, captured as it is registered.

const listen = vi.hoisted(() => ({ deps: null as null | Record<string, any> }));
const settle = vi.hoisted(() => ({ listener: null as null | ((key: string, last: { state: string }) => void) }));

vi.mock('../../src/bot/internalSetup/utils/sharedListener', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    startSharedListener: (deps: Record<string, any>) => { listen.deps = deps; },
    stopSharedListener: () => undefined,
  };
});

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    onRowKeySettled: (listener: (key: string, last: { state: string }) => void) => {
      settle.listener = listener;
      const off = real.onRowKeySettled(listener);
      return () => {
        if (settle.listener === listener) settle.listener = null;
        off();
      };
    },
  };
});

import {
  _resetSharedMirror, applySharedKeys, runSharedPass, setSharedModulePassStep, startSharedPass, stopSharedPass,
  type ModulePassStep,
} from '../../src/bot/internalSetup/utils/sharedMirror';
import { mirrorRig } from '../helpers/nb6Mirror';
import { pgError } from '../helpers/sharedRows';

const rig = mirrorRig('re5runs');
const KEY = rig.keyOf('a.json');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const READ_LINE = '[Shared] Could not check the shared files against the database (';
const STOP_LINE = '[Shared] The pass over the shared files stopped (boom); it tries again at the next pass';

interface Call { modules?: string[] }
let calls: Call[];
let behave: (call: Call) => Promise<boolean | { cause: string }>;
const step: ModulePassStep = async p => {
  const call = { modules: p.modules };
  calls.push(call);
  return behave(call);
};
const moduleCalls = () => calls.filter(c => c.modules !== undefined);
const fullCalls = () => calls.filter(c => c.modules === undefined);
const keyLists = () => rig.state.pg.sent.filter(s => s.sql === LIST_KEYS).length;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** The first body read of the key waits for the returned release; every later one answers at once. */
function holdFirstBody(): () => void {
  const held = deferred();
  let first = true;
  rig.state.rows.fault = sql => {
    if (sql !== BODY || !first) return undefined;
    first = false;
    return held.promise.then(() => undefined);
  };
  return held.resolve;
}

const bodySent = () => rig.state.pg.sent.some(s => s.sql === BODY);

beforeEach(async () => {
  listen.deps = null;
  settle.listener = null;
  calls = [];
  behave = async () => true;
  await rig.setup();
});

afterEach(async () => {
  setSharedModulePassStep(null);
  await rig.teardown();
});

describe("the settle of this process's last op of a key", () => {
  it('a landed op of a key no pass skipped runs no apply of that key; a refused one does', async () => {
    const other = rig.keyOf('b.json');
    startSharedPass();
    rig.state.rows.put(KEY, 'A');
    rig.state.rows.put(other, 'B');
    settle.listener!(KEY, { state: 'landed' });
    settle.listener!(other, { state: 'refused' });
    await vi.waitFor(() => expect(rig.read('b.json')).toBe('B'), { timeout: 5000 });
    await ticks();
    expect(rig.read('a.json')).toBeNull();
    expect(keyLists()).toBe(1);
  });

  it('an op whose commit was not confirmed runs the apply of its key', async () => {
    startSharedPass();
    rig.state.rows.put(KEY, 'A');
    settle.listener!(KEY, { state: 'unconfirmed' });
    await vi.waitFor(() => expect(rig.read('a.json')).toBe('A'), { timeout: 5000 });
  });
});

describe('the 60 s timer', () => {
  it('a tick while a pass runs starts no second pass', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setSharedModulePassStep(step);
    startSharedPass();
    const held = deferred();
    behave = async c => {
      if (c.modules === undefined && fullCalls().length === 1) await held.promise;
      return true;
    };
    const first = runSharedPass();
    await vi.waitFor(() => expect(fullCalls()).toHaveLength(1), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(60_000);
    held.resolve();
    await expect(first).resolves.toMatchObject({ answered: true });
    await ticks();
    expect(fullCalls()).toHaveLength(1);
    expect(rig.state.pg.sent.filter(s => s.sql === LIST)).toHaveLength(1);
  });
});

describe("the listener's hooks", () => {
  it('a connect after the stop runs no pass and asks the sweep for nothing', async () => {
    const guildRequests = vi.fn();
    startSharedPass({ guildRequests });
    listen.deps!.onConnected();
    expect(guildRequests).toHaveBeenCalledTimes(1);
    stopSharedPass();
    listen.deps!.onConnected();
    expect(guildRequests).toHaveBeenCalledTimes(1);
  });

  it("a guild request addressed to this process asks NB7's sweep for a pass", () => {
    const guildRequests = vi.fn();
    startSharedPass({ guildRequests });
    listen.deps!.onGuildRequest();
    expect(guildRequests).toHaveBeenCalledTimes(1);
  });

  it("the listener's database-changed call runs when the data pool moves to another database", () => {
    startSharedPass();
    const cb = vi.fn();
    listen.deps!.onDatabaseChanged(cb);
    const listeners = (rig.state.pg.backend as unknown as { databaseListeners: Array<(entry: string) => void> }).databaseListeners;
    for (const listener of listeners) listener('postgres://nobody@127.0.0.1:9/other');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('_resetSharedMirror starts the next process clean', () => {
  it("an apply left running does not hold up the next process's apply of the same key", async () => {
    rig.state.rows.put(KEY, 'A');
    const release = holdFirstBody();
    const before = applySharedKeys([KEY]);
    try {
      await vi.waitFor(() => expect(bodySent()).toBe(true), { timeout: 5000 });
      _resetSharedMirror();
      const after = applySharedKeys([KEY]);
      await vi.waitFor(() => expect(rig.read('a.json')).toBe('A'), { timeout: 5000 });
      await expect(after).resolves.toEqual({ answered: true, cause: null });
    } finally {
      release();
      await before;
    }
  });

  it('a notice that arrived during an apply before the reset runs no apply after it', async () => {
    startSharedPass();
    rig.state.rows.put(KEY, 'A');
    const release = holdFirstBody();
    listen.deps!.onDoc(KEY);
    await vi.waitFor(() => expect(bodySent()).toBe(true), { timeout: 5000 });
    listen.deps!.onDoc(KEY);
    _resetSharedMirror();
    release();
    await vi.waitFor(() => expect(rig.read('a.json')).toBe('A'), { timeout: 5000 });
    await ticks();
    expect(keyLists()).toBe(1);
  });

  it("a module run left running does not hold up the next process's notice for that module", async () => {
    setSharedModulePassStep(step);
    startSharedPass();
    const held = deferred();
    behave = async c => {
      if (c.modules && moduleCalls().length === 1) await held.promise;
      return true;
    };
    listen.deps!.onModule('m');
    try {
      await vi.waitFor(() => expect(moduleCalls()).toHaveLength(1), { timeout: 5000 });
      _resetSharedMirror();
      setSharedModulePassStep(step);
      listen.deps!.onModule('m');
      await vi.waitFor(() => expect(moduleCalls()).toHaveLength(2), { timeout: 5000 });
    } finally {
      held.resolve();
    }
  });

  it('a module notice that arrived during a run before the reset runs the step no more', async () => {
    setSharedModulePassStep(step);
    startSharedPass();
    const held = deferred();
    behave = async c => {
      if (c.modules && moduleCalls().length === 1) await held.promise;
      return true;
    };
    listen.deps!.onModule('m');
    await vi.waitFor(() => expect(moduleCalls()).toHaveLength(1), { timeout: 5000 });
    listen.deps!.onModule('m');
    _resetSharedMirror();
    setSharedModulePassStep(step);
    held.resolve();
    await ticks();
    expect(moduleCalls()).toHaveLength(1);
  });

  it("a failed listing is logged again by the next process", async () => {
    rig.state.rows.fault = sql => (sql === LIST ? pgError('42501', 'permission denied for table shared_docs') : undefined);
    await expect(runSharedPass()).resolves.toMatchObject({ answered: false });
    expect(rig.state.lines.filter(l => l.startsWith(READ_LINE))).toHaveLength(1);
    _resetSharedMirror();
    await expect(runSharedPass()).resolves.toMatchObject({ answered: false });
    expect(rig.state.lines.filter(l => l.startsWith(READ_LINE))).toHaveLength(2);
  });

  it("a pass that stopped on a throw is logged again by the next process", async () => {
    setSharedModulePassStep(step);
    behave = async () => { throw new Error('boom'); };
    await expect(runSharedPass()).resolves.toEqual({ answered: false, cause: 'boom' });
    expect(rig.state.lines.filter(l => l === STOP_LINE)).toHaveLength(1);
    _resetSharedMirror();
    setSharedModulePassStep(step);
    await expect(runSharedPass()).resolves.toEqual({ answered: false, cause: 'boom' });
    expect(rig.state.lines.filter(l => l === STOP_LINE)).toHaveLength(2);
  });
});
