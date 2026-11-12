import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { useStoreLanding } from '../../src/bot/internalSetup/utils/sharedStore';
import { readDocRecord, writeDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import * as sm from '../../src/bot/internalSetup/utils/sharedMirror';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { pgError, sha } from '../helpers/sharedRows';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('rc7');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const PRUNE = "DELETE FROM smdb_data.shared_ops WHERE at < now() - interval '7 days'";
const STORE_KEY = 'global/appstore/installed.json';
const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

beforeEach(() => m.setup());
afterEach(async () => {
  sm.setSharedLinesPassStep(null);
  useStoreLanding(null);
  await m.teardown();
});

const count = (sql: string) => m.sql().filter(s => s === sql).length;
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

type Hold = { promise: Promise<void>; release: () => void };
const hold = (): Hold => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

/** Holds the first open of the named mirror's write until released. */
function holdMirrorWrite(name: string) {
  const gate = hold();
  const state = { opened: false };
  const realOpen = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: any[]) => {
    if (!state.opened && String(p).startsWith(m.file(name))) {
      state.opened = true;
      await gate.promise;
    }
    return (realOpen as any)(p, ...rest);
  }) as any);
  return { ...gate, state };
}

/** Date.now frozen at the value; past a large count of calls it runs again, so a busy wait in a writer still ends. */
function freezeNow(at: number) {
  let calls = 0;
  const real = Date.now.bind(Date);
  return vi.spyOn(Date, 'now').mockImplementation(() => (++calls > 20_000 ? real() : at));
}

/** Every shared transaction the pass starts, settled or not; reject makes the next one reject before it reaches the wire. */
function trackTx() {
  const backend = m.state.pg.backend;
  const orig = backend.sharedTx.bind(backend);
  const t = { settled: [] as Promise<void>[], prunes: 0, reject: false };
  vi.spyOn(backend, 'sharedTx').mockImplementation(((spec: any) => {
    const statements = spec.check === null ? spec.statements(null) : [];
    if (Array.isArray(statements) && statements.some((s: { text: string }) => s.text === PRUNE)) t.prunes += 1;
    let p: Promise<unknown>;
    if (t.reject) {
      t.reject = false;
      p = Promise.reject(new Error('the pool was closed'));
    } else {
      p = orig(spec);
    }
    t.settled.push(p.then(() => undefined, () => undefined));
    return p;
  }) as any);
  return t;
}

async function passAt(at: number, t: ReturnType<typeof trackTx>, opts: { rehash?: boolean } = {}) {
  const spy = freezeNow(at);
  let res: sm.PassResult;
  try {
    res = await sm.runSharedPass(opts);
  } finally {
    spy.mockRestore();
  }
  await Promise.all(t.settled);
  await ticks();
  return res;
}

describe("decision 24's prune of shared_ops", () => {
  it('deletes at most once an hour: not again after 1 s or 30 min, again after 61 min', async () => {
    const t = trackTx();
    expect((await passAt(T0, t)).answered).toBe(true);
    expect(count(PRUNE)).toBe(1);
    expect((await passAt(T0 + 1000, t)).answered).toBe(true);
    expect((await passAt(T0 + 30 * 60_000, t)).answered).toBe(true);
    expect(count(PRUNE)).toBe(1);
    await passAt(T0 + 61 * 60_000, t);
    expect(count(PRUNE)).toBe(2);
    await passAt(T0 + 62 * 60_000, t);
    expect(count(PRUNE)).toBe(2);
  });

  it('a prune whose delete failed is tried again at the next pass, within the hour', async () => {
    const t = trackTx();
    let failures = 0;
    m.state.rows.fault = sql => {
      if (sql === PRUNE && failures === 0) {
        failures += 1;
        return pgError('57014', 'canceling statement due to statement timeout');
      }
      return undefined;
    };
    await passAt(T0, t);
    expect(failures).toBe(1);
    expect(count(PRUNE)).toBe(1);
    await passAt(T0 + 1000, t);
    expect(count(PRUNE)).toBe(2);
    expect(m.state.rows.prunes).toHaveLength(1);
    await passAt(T0 + 2000, t);
    expect(count(PRUNE)).toBe(2);
  });

  it('a prune whose transaction rejected is tried again at the next pass', async () => {
    const t = trackTx();
    t.reject = true;
    await passAt(T0, t);
    expect(t.prunes).toBe(1);
    expect(count(PRUNE)).toBe(0);
    await passAt(T0 + 1000, t);
    expect(t.prunes).toBe(2);
    expect(count(PRUNE)).toBe(1);
  });

  it('sends the delete with no parameters, as its statement has no placeholder', async () => {
    const t = trackTx();
    await passAt(T0, t);
    const sent = m.state.pg.sent.filter(s => s.sql === PRUNE);
    expect(sent).toHaveLength(1);
    const values = sent[0].params ?? (sent[0].raw as { values?: unknown[] })?.values ?? [];
    expect(values).toEqual([]);
  });

  it('starts no prune once the stop came during the pass', async () => {
    const t = trackTx();
    sm.setSharedModulePassStep(async () => {
      sm.stopSharedPass();
      return true;
    });
    const res = await passAt(T0, t);
    expect(res.answered).toBe(true);
    expect(t.prunes).toBe(0);
    expect(count(PRUNE)).toBe(0);
  });
});

describe('the rehash of the mirrors', () => {
  /** A mirror edited behind the bot whose stamp is still the record's, so only a rehash sees the change. */
  async function stampedEdit(name: string): Promise<void> {
    await m.landed(name, { v: 1 });
    fs.writeFileSync(m.file(name), 'edited behind the bot');
    const st = fs.lstatSync(m.file(name));
    const stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
    const read = readDocRecord();
    if (!read.ok) throw new Error(read.reason);
    const key = m.keyOf(name);
    writeDocRecord({ ...read.record, docs: { ...read.record.docs, [key]: { ...read.record.docs[key], stamp } } });
  }

  const movedAside = () => Object.values(m.superseded());

  it('a pass asked to rehash finds a mirror edited behind the bot and puts the row back', async () => {
    await stampedEdit('a.json');
    await sm.runSharedPass();
    expect(m.read('a.json')).toBe('edited behind the bot');
    const res = await sm.runSharedPass({ rehash: true });
    expect(res.answered).toBe(true);
    expect(m.read('a.json')).toBe(text({ v: 1 }));
    expect(movedAside()).toEqual(['edited behind the bot']);
    expect(m.entry('a.json')).toMatchObject({ sha: sha(text({ v: 1 })) });
  });

  it('the 60th pass rehashes on its own, and the 59 before it do not', async () => {
    await stampedEdit('b.json');
    for (let n = 1; n <= 59; n++) {
      const res = await sm.runSharedPass();
      expect(res.answered).toBe(true);
    }
    expect(m.read('b.json')).toBe('edited behind the bot');
    expect(movedAside()).toEqual([]);
    await sm.runSharedPass();
    expect(m.read('b.json')).toBe(text({ v: 1 }));
    expect(movedAside()).toEqual(['edited behind the bot']);
  }, 20_000);
});

describe("premium's journal read after a full pass", () => {
  it('a failed journal read makes the pass unanswered with its cause', async () => {
    const step = vi.fn(async () => ({ ok: false as const, cause: 'the journal read timed out' }));
    sm.setSharedLinesPassStep(step);
    expect(await sm.runSharedPass()).toEqual({ answered: false, cause: 'the journal read timed out' });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('is not read when the listing failed, and the pass answers the listing\'s cause', async () => {
    const step = vi.fn(async () => ({ ok: false as const, cause: 'the journal read timed out' }));
    sm.setSharedLinesPassStep(step);
    m.state.rows.fault = sql => (sql === LIST ? pgError('57P01', 'terminating connection due to administrator command') : undefined);
    expect(await sm.runSharedPass()).toEqual({ answered: false, cause: 'terminating connection due to administrator command' });
    expect(step).not.toHaveBeenCalled();
  });
});

describe("the pass's module step", () => {
  it('a module step that answers false makes the pass unanswered', async () => {
    const step = vi.fn(async () => false);
    sm.setSharedModulePassStep(step);
    expect(await sm.runSharedPass()).toEqual({ answered: false, cause: null });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('is not run once the stop came during the last doc key, and the pass is cut short', async () => {
    await m.landed('c.json', { v: 1 });
    m.state.rows.put(m.keyOf('c.json'), text({ v: 2 }));
    const step = vi.fn(async () => true);
    sm.setSharedModulePassStep(step);
    const write = holdMirrorWrite('c.json');
    const run = sm.runSharedPass();
    await vi.waitFor(() => expect(write.state.opened).toBe(true), { timeout: 2000, interval: 5 });
    sm.stopSharedPass();
    write.release();
    expect(await run).toEqual({ answered: false, cause: null });
    expect(step).not.toHaveBeenCalled();
  });
});

describe("the bot's App Store keys in a pass", () => {
  it('are not applied once the stop came during the last doc key, and the pass is cut short', async () => {
    await m.landed('d.json', { v: 1 });
    m.state.rows.put(m.keyOf('d.json'), text({ v: 2 }));
    m.state.rows.put(STORE_KEY, text({ modules: {} }));
    const write = holdMirrorWrite('d.json');
    const run = sm.applySharedKeys([m.keyOf('d.json'), STORE_KEY]);
    await vi.waitFor(() => expect(write.state.opened).toBe(true), { timeout: 2000, interval: 5 });
    sm.stopSharedPass();
    write.release();
    expect(await run).toEqual({ answered: false, cause: null });
    expect(fs.existsSync(dataPath(...STORE_KEY.split('/')))).toBe(false);
  });

  it('a pass with no App Store key does not wait for the store mutex', async () => {
    await m.landed('e.json', { v: 1 });
    m.state.rows.put(m.keyOf('e.json'), text({ v: 2 }));
    const held = hold();
    const acquire = vi.fn(async () => {
      await held.promise;
      return { release: () => undefined };
    });
    useStoreLanding({ acquire, locked: fn => fn() });
    const state: { res?: sm.PassResult } = {};
    const run = sm.applySharedKeys([m.keyOf('e.json')]).then(res => { state.res = res; });
    try {
      await vi.waitFor(() => expect(state.res).toBeDefined(), { timeout: 2000, interval: 5 });
      expect(state.res).toEqual({ answered: true, cause: null });
      expect(m.read('e.json')).toBe(text({ v: 2 }));
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      held.release();
      await run;
    }
  });
});

describe('one full pass at a time', () => {
  it('a pass asked for while one runs starts after it ends', async () => {
    await m.landed('f.json', { v: 1 });
    m.state.rows.put(m.keyOf('f.json'), text({ v: 2 }));
    const write = holdMirrorWrite('f.json');
    const first = sm.runSharedPass();
    await vi.waitFor(() => expect(write.state.opened).toBe(true), { timeout: 2000, interval: 5 });
    expect(count(LIST)).toBe(1);
    const second = sm.runSharedPass();
    const sentinel = sm.applySharedKeys([m.keyOf('none.json')]);
    await vi.waitFor(() => expect(count(LIST_KEYS)).toBe(1), { timeout: 2000, interval: 5 });
    await ticks();
    expect(count(LIST)).toBe(1);
    write.release();
    expect((await first).answered).toBe(true);
    expect((await second).answered).toBe(true);
    await sentinel;
    expect(count(LIST)).toBe(2);
    expect(m.read('f.json')).toBe(text({ v: 2 }));
    expect(fs.existsSync(path.join(dataPath('global', 'rc7'), 'none.json'))).toBe(false);
  });
});
