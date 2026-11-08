import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { applySharedKeys, refreshShared, runSharedPass, stopSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 code review round 1, lane B findings 1, 2, 4 and 9 (out/NB6/review1-B.md; ruled in part-rulings.md "Code review
// round 1"): the mirror pass against a body read answered late, an unreadable doc record, a stop after the listing
// and refreshShared's bound. Rows are stored by the real flush and by another machine's rows.put.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6fixr1');
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => m.setup());
afterEach(() => m.teardown());

/** Holds the answer of the first body read of key after the database gave it, as a slow link delivers it. */
function holdFirstBodyAnswer(key: string) {
  const backend = m.state.pg.backend;
  const real = backend.sharedSelect.bind(backend);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seen!: () => void;
  const answered = new Promise<void>(resolve => { seen = resolve; });
  let first = true;
  vi.spyOn(backend, 'sharedSelect').mockImplementation(async (text: string, values: unknown[], boundMs: number) => {
    const res = await real(text, values, boundMs);
    if (first && text === BODY && values[0] === key) {
      first = false;
      seen();
      await gate;
    }
    return res;
  });
  return { answered, release };
}

describe('B1: a body read answered after the entry moved', () => {
  it("(b) this process's op lands during the read: the pass reads the row again and keeps the newer version", async () => {
    await m.landed('k.json', { v: 1 });
    m.state.rows.put(m.keyOf('k.json'), text({ v: 'theirs' }));
    const hold = holdFirstBodyAnswer(m.keyOf('k.json'));
    const pass = runSharedPass();
    await hold.answered;
    dm.updateGlobalData('k.json', { v: 0 }, (current: any) => ({ v: `${current.v}+mine` }), 'nb6fixr1');
    await dm.flushAll();
    expect(rowQueue.ops(m.keyOf('k.json'))).toEqual([]);
    expect(m.read('k.json')).toBe(text({ v: 'theirs+mine' }));
    hold.release();
    const res = await pass;
    expect(res.answered).toBe(true);
    expect(m.read('k.json')).toBe(text({ v: 'theirs+mine' }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 'theirs+mine' })));
    expect(m.superseded()).toEqual({});
  });

  it("(a) a key's apply waits for the pass's apply of that key, and the mirror ends at the newest row", async () => {
    await m.landed('k.json', { v: 1 });
    m.state.rows.put(m.keyOf('k.json'), text({ v: 2 }));
    const hold = holdFirstBodyAnswer(m.keyOf('k.json'));
    const pass = runSharedPass();
    await hold.answered;
    m.state.rows.put(m.keyOf('k.json'), text({ v: 3 }));
    const keyed = applySharedKeys([m.keyOf('k.json')]);
    await Promise.race([keyed, pause()]);
    expect(m.sql().filter(s => s === BODY)).toHaveLength(1);
    hold.release();
    await pass;
    await keyed;
    expect(m.read('k.json')).toBe(text({ v: 3 }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 3 })));
    expect(m.superseded()).toEqual({});
  });
});

describe('B2: the doc record cannot be parsed', () => {
  it('moves it into _superseded with the ruled line, starts a new record and brings the mirrors up to date', async () => {
    const record = dataPath('.shared-mirror.json');
    fs.writeFileSync(record, '{"docs": {');
    m.state.rows.put(m.keyOf('k.json'), text({ v: 'theirs' }));
    const res = await runSharedPass();
    expect(res).toEqual({ answered: true, cause: null });
    expect(m.read('k.json')).toBe(text({ v: 'theirs' }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 'theirs' })));
    const moved = Object.entries(m.superseded()).filter(([rel]) => rel.endsWith('/.shared-mirror.json'));
    expect(moved.map(([, bytes]) => bytes)).toEqual(['{"docs": {']);
    const dest = path.join(dataPath('_superseded'), ...moved[0][0].split('/'));
    expect(m.state.lines).toContain(`[Shared] The record of the shared files (${record}) could not be read (it is not JSON); it was moved to ${dest} and a new record was started`);
  });
});

describe('B4: a stop that begins after the listing', () => {
  it("refreshShared answers that the bot process is stopping, not ok", async () => {
    m.state.rows.put(m.keyOf('a.json'), text({ a: 1 }));
    m.state.rows.put(m.keyOf('b.json'), text({ b: 1 }));
    const hold = holdFirstBodyAnswer(m.keyOf('a.json'));
    const refresh = refreshShared([m.keyOf('a.json'), m.keyOf('b.json')]);
    await hold.answered;
    stopSharedPass();
    hold.release();
    await expect(refresh).resolves.toEqual({ ok: false, cause: 'the bot process is stopping' });
    expect(m.read('b.json')).toBeNull();
  });
});

describe("B9: refreshShared's bound cuts its pass", () => {
  it('a body read answered after the 10 s bound writes no mirror and no entry', async () => {
    await m.landed('k.json', { v: 1 });
    m.state.rows.put(m.keyOf('k.json'), text({ v: 2 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    m.state.rows.fault = sql => {
      if (sql.startsWith('SELECT key, sha FROM smdb_data.shared_docs')) return new Promise(resolve => setTimeout(resolve, 9000));
      if (sql === BODY) return new Promise(resolve => setTimeout(resolve, 2000));
      return undefined;
    };
    let answer: unknown = null;
    void refreshShared([m.keyOf('k.json')]).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(answer).toEqual({ ok: false, cause: 'no answer within 10 s' });
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await pause();
    expect(m.sql().filter(s => s === BODY)).toHaveLength(1);
    expect(m.read('k.json')).toBe(text({ v: 1 }));
    expect(m.entry('k.json')!.sha).toBe(sha(text({ v: 1 })));
  });
});
