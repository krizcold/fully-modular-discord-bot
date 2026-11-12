import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { docRecordPath, readDocRecord, writeDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { applySharedKeys, startSharedPass, stopSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';
import { mirrorRig, text } from '../helpers/nb6Mirror';
import { pgError, sha } from '../helpers/sharedRows';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('ra62');
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const NOT_UP_TO_DATE = '[Shared] Did not bring the shared files up to date: ';
const COULD_NOT_CHECK = '[Shared] Could not check';

type Hold = { promise: Promise<void>; release: () => void };
const hold = (): Hold => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

/** One fault for the scripted rows: body reads by their number from 1, and BEGIN while a hold is set. */
function faults() {
  const f = {
    bodyCalls: 0,
    body: undefined as ((n: number) => Error | Promise<void> | undefined) | undefined,
    begin: null as Promise<void> | null,
  };
  m.state.rows.fault = sql => {
    if (sql === BODY) {
      f.bodyCalls += 1;
      return f.body?.(f.bodyCalls);
    }
    if (f.begin && /^BEGIN/.test(sql)) return f.begin.then(() => undefined);
    return undefined;
  };
  return f;
}

/** Counts the answered key listings, and can rewrite the rows of a body read before the pass sees them. */
function wrapSelect(bodyRows?: (rows: any[]) => any[]) {
  const backend = m.state.pg.backend;
  const orig = backend.sharedSelect.bind(backend);
  const seen = { listed: 0 };
  vi.spyOn(backend, 'sharedSelect').mockImplementation((sql: string, values: unknown[], bound: number) => {
    const p = orig(sql, values, bound);
    if (sql === LIST_KEYS) p.then(() => { seen.listed += 1; }, () => undefined);
    if (sql === BODY && bodyRows) return p.then(res => ({ ...res, rows: bodyRows(res.rows) }));
    return p;
  });
  return seen;
}

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

const count = (sql: string) => m.sql().filter(s => s === sql).length;
const notUpToDate = () => m.state.lines.filter(l => l.startsWith(NOT_UP_TO_DATE));

/** A file where the _superseded folder goes, so no record can be moved aside. */
function blockMoves(): void {
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dataPath('_superseded')), { recursive: true });
  fs.writeFileSync(dataPath('_superseded'), 'in the way');
}

function setEntrySha(key: string, value: string): void {
  const read = readDocRecord();
  if (!read.ok) throw new Error(read.reason);
  writeDocRecord({ ...read.record, docs: { ...read.record.docs, [key]: { ...read.record.docs[key], sha: value } } });
}

beforeEach(() => m.setup());
afterEach(async () => {
  _setListenClientFactory(null);
  await m.teardown();
});

describe('a record that cannot be read is moved aside', () => {
  it('each record unreadable in the same millisecond gets its own numbered folder under _superseded', async () => {
    await m.landed('a.json', { v: 1 });
    const at = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(at);
    const base = path.basename(docRecordPath());
    for (const n of [1, 2]) {
      fs.writeFileSync(docRecordPath(), `not json ${n}`);
      await applySharedKeys([m.keyOf('a.json')]);
    }
    expect(m.superseded()).toEqual({ [`shared-${at}/${base}`]: 'not json 1', [`shared-${at}-1/${base}`]: 'not json 2' });
    fs.writeFileSync(docRecordPath(), 'not json 3');
    await applySharedKeys([m.keyOf('a.json')]);
    expect(m.superseded()).toEqual({
      [`shared-${at}/${base}`]: 'not json 1',
      [`shared-${at}-1/${base}`]: 'not json 2',
      [`shared-${at}-2/${base}`]: 'not json 3',
    });
    expect(fs.existsSync(dataPath(`shared-${at}-1`))).toBe(false);
    const dest = path.join(dataPath('_superseded'), `shared-${at}-2`, base);
    expect(m.state.lines).toContain(`[Shared] The record of the shared files (${docRecordPath()}) could not be read (it is not JSON); it was moved to ${dest} and a new record was started`);
  });

  it('a record that cannot be read from disk logs the errno as its cause', async () => {
    await m.landed('b.json', { v: 1 });
    fs.rmSync(docRecordPath(), { force: true });
    fs.mkdirSync(docRecordPath());
    await applySharedKeys([m.keyOf('b.json')]);
    const moved = m.state.lines.filter(l => l.startsWith('[Shared] The record of the shared files'));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^\[Shared\] The record of the shared files \(.+\) could not be read \(EISDIR\); it was moved to .+ and a new record was started$/);
    expect(moved[0].startsWith(`[Shared] The record of the shared files (${docRecordPath()}) could not be read (EISDIR); it was moved to ${dataPath('_superseded')}`)).toBe(true);
  });
});

describe('a record that cannot be read or moved aside', () => {
  it('is left as it is and logged once per cause, with the move\'s errno', async () => {
    await m.landed('c.json', { v: 1 });
    m.state.rows.put(m.keyOf('c.json'), text({ v: 2 }));
    fs.writeFileSync(docRecordPath(), 'not json');
    blockMoves();
    const first = await applySharedKeys([m.keyOf('c.json')]);
    await applySharedKeys([m.keyOf('c.json')]);
    expect(first.answered).toBe(true);
    const lines = notUpToDate();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[Shared\] Did not bring the shared files up to date: .+ is not JSON, and it could not be moved aside \([A-Z]+\); the next pass tries again$/);
    expect(lines[0].startsWith(`${NOT_UP_TO_DATE}${docRecordPath()} is not JSON, and it could not be moved aside (`)).toBe(true);
    expect(m.state.lines.some(l => l.includes('a new record was started'))).toBe(false);
    expect(fs.readFileSync(docRecordPath(), 'utf8')).toBe('not json');
    expect(m.read('c.json')).toBe(text({ v: 1 }));
  });

  it('logs the same cause again after a record was moved aside in between', async () => {
    await m.landed('d.json', { v: 1 });
    fs.writeFileSync(docRecordPath(), 'not json');
    blockMoves();
    await applySharedKeys([m.keyOf('d.json')]);
    expect(notUpToDate()).toHaveLength(1);
    fs.rmSync(dataPath('_superseded'), { force: true });
    await applySharedKeys([m.keyOf('d.json')]);
    expect(m.state.lines.some(l => l.includes('a new record was started'))).toBe(true);
    fs.writeFileSync(docRecordPath(), 'not json');
    blockMoves();
    await applySharedKeys([m.keyOf('d.json')]);
    const lines = notUpToDate();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(lines[0]);
  });

  it('logs when the record went bad while the mirror was written', async () => {
    await m.landed('e.json', { v: 1 });
    m.state.rows.put(m.keyOf('e.json'), text({ v: 2 }));
    const realOpen = fs.promises.open;
    let spoiled = false;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: any[]) => {
      if (!spoiled && String(p).startsWith(m.file('e.json'))) {
        spoiled = true;
        fs.writeFileSync(docRecordPath(), 'not json');
        blockMoves();
      }
      return (realOpen as any)(p, ...rest);
    }) as any);
    await applySharedKeys([m.keyOf('e.json')]);
    expect(spoiled).toBe(true);
    expect(m.read('e.json')).toBe(text({ v: 2 }));
    expect(notUpToDate()).toHaveLength(1);
    expect(fs.readFileSync(docRecordPath(), 'utf8')).toBe('not json');
  });
});

describe('a record write that fails', () => {
  it('is logged again after a write of the record succeeded in between', async () => {
    await m.landed('f.json', { v: 1 });
    const record = docRecordPath();
    const realOpenSync = fs.openSync;
    let failing = true;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: any[]) => {
      if (failing && String(p).startsWith(`${record}.`)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return (realOpenSync as any)(p, ...rest);
    }) as any);
    const line = `[Shared] Could not write ${record} (ENOSPC); retrying`;
    m.state.rows.put(m.keyOf('f.json'), text({ v: 2 }));
    await applySharedKeys([m.keyOf('f.json')]);
    expect(m.state.lines.filter(l => l === line)).toHaveLength(1);
    failing = false;
    await applySharedKeys([m.keyOf('f.json')]);
    expect(m.entry('f.json')).toMatchObject({ sha: sha(text({ v: 2 })) });
    failing = true;
    m.state.rows.put(m.keyOf('f.json'), text({ v: 3 }));
    await applySharedKeys([m.keyOf('f.json')]);
    expect(m.state.lines.filter(l => l === line)).toHaveLength(2);
  });
});

describe('the row read', () => {
  it('a failed read is logged again after a read of the key succeeded in between', async () => {
    await m.landed('g.json', { v: 1 });
    const f = faults();
    f.body = () => pgError('55P03', 'relation is locked');
    m.state.rows.put(m.keyOf('g.json'), text({ v: 2 }));
    await applySharedKeys([m.keyOf('g.json')]);
    f.body = undefined;
    await applySharedKeys([m.keyOf('g.json')]);
    expect(m.read('g.json')).toBe(text({ v: 2 }));
    f.body = () => pgError('55P03', 'relation is locked');
    m.state.rows.put(m.keyOf('g.json'), text({ v: 3 }));
    await applySharedKeys([m.keyOf('g.json')]);
    const lines = m.state.lines.filter(l => l.startsWith(COULD_NOT_CHECK));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('relation is locked');
  });

  it('a body that comes back as text is written as its UTF-8 bytes', async () => {
    await m.landed('h.json', { v: 1 });
    wrapSelect(rows => rows.map(r => ({ ...r, body: Buffer.from(r.body).toString('utf8') })));
    m.state.rows.put(m.keyOf('h.json'), text({ v: 'two' }));
    await applySharedKeys([m.keyOf('h.json')]);
    expect(m.read('h.json')).toBe(text({ v: 'two' }));
  });

  it('a row with no body is written as an empty file', async () => {
    await m.landed('i.json', { v: 1 });
    wrapSelect(rows => rows.map(r => ({ ...r, body: null })));
    m.state.rows.put(m.keyOf('i.json'), text({ v: 2 }));
    await applySharedKeys([m.keyOf('i.json')]);
    expect(m.read('i.json')).toBe('');
  });

  it('a failed read before the lock answers unanswered and leaves the mirror, even when a later read would work', async () => {
    await m.landed('j.json', { v: 1 });
    const f = faults();
    f.body = n => (n === 1 ? pgError('55P03', 'relation is locked') : undefined);
    m.state.rows.put(m.keyOf('j.json'), text({ v: 2 }));
    const res = await applySharedKeys([m.keyOf('j.json')]);
    expect(res).toEqual({ answered: false, cause: 'relation is locked' });
    expect(m.read('j.json')).toBe(text({ v: 1 }));
    expect(f.bodyCalls).toBe(1);
  });

  it('a key deleted from the database is read once before its mirror is removed', async () => {
    await m.landed('k.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('k.json'));
    await applySharedKeys([m.keyOf('k.json')]);
    expect(fs.existsSync(m.file('k.json'))).toBe(false);
    expect(m.entry('k.json')).toBeUndefined();
    expect(count(BODY)).toBe(1);
  });

  it('a key with no row, no mirror and no entry writes no record', async () => {
    const res = await applySharedKeys([m.keyOf('none.json')]);
    expect(res.answered).toBe(true);
    expect(fs.existsSync(docRecordPath())).toBe(false);
    expect(fs.existsSync(dataPath('_superseded'))).toBe(false);
  });

  it('a mirror edited to the version the row turned into while it was read is kept, not moved aside', async () => {
    await m.landed('l.json', { v: 1 });
    m.state.rows.put(m.keyOf('l.json'), text({ v: 2 }));
    fs.writeFileSync(m.file('l.json'), text({ v: 3 }));
    const f = faults();
    f.body = n => {
      if (n === 1) m.state.rows.put(m.keyOf('l.json'), text({ v: 3 }));
      return undefined;
    };
    await applySharedKeys([m.keyOf('l.json')]);
    expect(m.read('l.json')).toBe(text({ v: 3 }));
    expect(m.entry('l.json')).toMatchObject({ sha: sha(text({ v: 3 })) });
    expect(m.superseded()).toEqual({});
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Moved'))).toEqual([]);
  });
});

describe('the record changes while the row is read', () => {
  it('logs a record that went bad during the read before the lock', async () => {
    await m.landed('n.json', { v: 1 });
    m.state.rows.put(m.keyOf('n.json'), text({ v: 2 }));
    const f = faults();
    f.body = n => {
      if (n === 1) {
        fs.writeFileSync(docRecordPath(), 'not json');
        blockMoves();
      }
      return undefined;
    };
    await applySharedKeys([m.keyOf('n.json')]);
    expect(notUpToDate()).toHaveLength(1);
    expect(m.read('n.json')).toBe(text({ v: 1 }));
  });

  /** The first read sees the entry moved to v2 (another pass applied it); the second read, under the lock, is n === 2. */
  function entryMoves(name: string, second: () => Error | Promise<void> | undefined) {
    const f = faults();
    f.body = n => {
      if (n === 1) {
        fs.writeFileSync(m.file(name), text({ v: 2 }));
        setEntrySha(m.keyOf(name), sha(text({ v: 2 })));
        return undefined;
      }
      return n === 2 ? second() : undefined;
    };
    return f;
  }

  it('a failed read under the lock answers unanswered', async () => {
    await m.landed('o.json', { v: 1 });
    m.state.rows.put(m.keyOf('o.json'), text({ v: 2 }));
    const f = entryMoves('o.json', () => pgError('55P03', 'relation is locked'));
    const res = await applySharedKeys([m.keyOf('o.json')]);
    expect(f.bodyCalls).toBe(2);
    expect(res).toEqual({ answered: false, cause: 'relation is locked' });
    expect(m.state.lines.filter(l => l.startsWith(COULD_NOT_CHECK))).toHaveLength(1);
  });

  it('a stop during the read under the lock ends the apply cut short', async () => {
    await m.landed('p.json', { v: 1 });
    m.state.rows.put(m.keyOf('p.json'), text({ v: 2 }));
    const gate = hold();
    const f = entryMoves('p.json', () => gate.promise);
    const run = applySharedKeys([m.keyOf('p.json')]);
    await vi.waitFor(() => expect(f.bodyCalls).toBe(2), { timeout: 2000, interval: 5 });
    stopSharedPass();
    gate.release();
    expect(await run).toEqual({ answered: false, cause: null });
  });

  it('logs a record that went bad during the read under the lock', async () => {
    await m.landed('q.json', { v: 1 });
    m.state.rows.put(m.keyOf('q.json'), text({ v: 2 }));
    const f = entryMoves('q.json', () => {
      fs.writeFileSync(docRecordPath(), 'not json');
      blockMoves();
      return undefined;
    });
    await applySharedKeys([m.keyOf('q.json')]);
    expect(f.bodyCalls).toBe(2);
    expect(notUpToDate()).toHaveLength(1);
  });
});

describe('one apply per key at a time', () => {
  it('a third apply waits for the second even after the first ended', async () => {
    await m.landed('r.json', { v: 1 });
    m.state.rows.put(m.keyOf('r.json'), text({ v: 2 }));
    const write = holdMirrorWrite('r.json');
    const gate2 = hold();
    const f = faults();
    f.body = n => (n >= 2 ? gate2.promise : undefined);
    const seen = wrapSelect();
    const a = applySharedKeys([m.keyOf('r.json')]);
    await vi.waitFor(() => expect(write.state.opened).toBe(true), { timeout: 2000, interval: 5 });
    m.state.rows.put(m.keyOf('r.json'), text({ v: 3 }));
    const b = applySharedKeys([m.keyOf('r.json')]);
    await vi.waitFor(() => expect(seen.listed).toBe(2), { timeout: 2000, interval: 5 });
    write.release();
    await vi.waitFor(() => expect(f.bodyCalls).toBe(2), { timeout: 2000, interval: 5 });
    const c = applySharedKeys([m.keyOf('r.json')]);
    await vi.waitFor(() => expect(seen.listed).toBe(3), { timeout: 2000, interval: 5 });
    gate2.release();
    await Promise.all([a, b, c]);
    expect(m.read('r.json')).toBe(text({ v: 3 }));
    expect(f.bodyCalls).toBe(2);
  });

  it('an apply queued behind another one reads nothing once the stop came', async () => {
    await m.landed('s.json', { v: 1 });
    m.state.rows.put(m.keyOf('s.json'), text({ v: 2 }));
    const write = holdMirrorWrite('s.json');
    const f = faults();
    const seen = wrapSelect();
    const a = applySharedKeys([m.keyOf('s.json')]);
    await vi.waitFor(() => expect(write.state.opened).toBe(true), { timeout: 2000, interval: 5 });
    m.state.rows.put(m.keyOf('s.json'), text({ v: 3 }));
    const b = applySharedKeys([m.keyOf('s.json')]);
    await vi.waitFor(() => expect(seen.listed).toBe(2), { timeout: 2000, interval: 5 });
    stopSharedPass();
    const atStop = f.bodyCalls;
    write.release();
    await a;
    expect(await b).toEqual({ answered: false, cause: null });
    expect(f.bodyCalls).toBe(atStop);
  });
});

describe('a key left for a pending op of this process', () => {
  async function listening(): Promise<void> {
    const rig = listenRig();
    _setListenClientFactory(rig.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'), { timeout: 2000, interval: 5 });
  }

  it('is applied again once the op landed, when it was pending at the start', async () => {
    await listening();
    await m.landed('t.json', { v: 1 });
    const f = faults();
    const begin = hold();
    f.begin = begin.promise;
    const save = dm.saveDataTracked('t.json', m.opts, { v: 'mine' }) as { ticket?: RowTicket };
    await applySharedKeys([m.keyOf('t.json')]);
    expect(count(BODY)).toBe(0);
    const listed = count(LIST_KEYS);
    f.begin = null;
    begin.release();
    await dm.flushAll();
    expect(rowTicketState(save.ticket!)).toBe('landed');
    await vi.waitFor(() => expect(count(LIST_KEYS)).toBeGreaterThan(listed), { timeout: 2000, interval: 5 });
  });

  it('is applied again once the op landed, when the op came during the row read', async () => {
    await listening();
    await m.landed('u.json', { v: 1 });
    setEntrySha(m.keyOf('u.json'), 'stale');
    const f = faults();
    const read = hold();
    const begin = hold();
    f.body = n => (n === 1 ? read.promise : undefined);
    const run = applySharedKeys([m.keyOf('u.json')]);
    await vi.waitFor(() => expect(f.bodyCalls).toBe(1), { timeout: 2000, interval: 5 });
    f.begin = begin.promise;
    const save = dm.saveDataTracked('u.json', m.opts, { v: 'mine' }) as { ticket?: RowTicket };
    read.release();
    await run;
    expect(m.read('u.json')).toBe(text({ v: 1 }));
    const listed = count(LIST_KEYS);
    f.begin = null;
    begin.release();
    await dm.flushAll();
    expect(rowTicketState(save.ticket!)).toBe('landed');
    await vi.waitFor(() => expect(count(LIST_KEYS)).toBeGreaterThan(listed), { timeout: 2000, interval: 5 });
  });
});
