import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as sm from '../../src/bot/internalSetup/utils/sharedMirror';
import { mirrorRig, setView, T11, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';
import { REAL_FS } from '../helpers/forwardingFs';

// L5 run A, chunk 61 (sharedMirror.ts): the read-failed lines, the stat and hash of a mirror (decision 49's racy-clean
// stamp, 'absent' and 'unreadable'), the move aside into _superseded and its lines, and the hourly prune.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('ra61');
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const LIST_KEYS = 'SELECT key, sha FROM smdb_data.shared_docs WHERE key = ANY($1)';
const T0 = 1_800_000_000_000;
const realFs = (): any => (fs as any)[REAL_FS];

beforeEach(async () => {
  await m.setup();
  sm._resetSharedMirror();
});
afterEach(async () => {
  sm._resetSharedMirror();
  await m.teardown();
});

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Date.now frozen at the value; past a large count of calls it runs again, so a busy wait in a writer still ends. */
function freezeNow(at: () => number): void {
  let calls = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => (++calls > 20_000 ? real() : at()));
}

const errno = (code: string) => Object.assign(new Error(`${code}: operation failed`), { code });

function failCall(fn: 'lstatSync' | 'readFileSync' | 'renameSync', file: string, error: unknown, times = Infinity): () => number {
  let hits = 0;
  vi.spyOn(fs, fn as any).mockImplementation(((...args: unknown[]) => {
    const target = fn === 'renameSync' ? String(args[1]) : String(args[0]);
    const match = fn === 'renameSync' ? same(String(args[0]), file) && target.includes('_superseded') : same(target, file);
    if (match && hits < times) {
      hits += 1;
      throw error;
    }
    return realFs()[fn](...args);
  }) as any);
  return () => hits;
}

function seedLoose(name: string, body: string): void {
  fs.mkdirSync(path.dirname(m.file(name)), { recursive: true });
  fs.writeFileSync(m.file(name), body);
}

function putRow(name: string, body: string, rowSha: string): void {
  m.state.rows.docs.set(m.keyOf(name), { body: Buffer.from(body), sha: rowSha, rev: '1', updated_at: new Date(), updated_by: 'BRAVO/p-bravo' });
}

describe('the read-failed line names its subject', () => {
  it('a failed listing reads "the shared files"', async () => {
    await m.landed('list.json', { v: 1 });
    m.state.rows.fault = sql => (sql === LIST_KEYS ? Object.assign(new Error('relation is locked'), { code: '55P03', severity: 'ERROR' }) : undefined);
    const res = await sm.applySharedKeys([m.keyOf('list.json')]);
    expect(res.answered).toBe(false);
    const lines = m.state.lines.filter(l => l.startsWith('[Shared] Could not check'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[Shared\] Could not check the shared files against the database \(.*relation is locked.*\); the next pass tries again$/);
  });

  it('a failed row read names the key', async () => {
    await m.landed('row.json', { v: 1 });
    m.state.rows.put(m.keyOf('row.json'), text({ v: 2 }));
    m.state.rows.fault = sql => (sql === BODY ? Object.assign(new Error('relation is locked'), { code: '55P03', severity: 'ERROR' }) : undefined);
    await sm.applySharedKeys([m.keyOf('row.json')]);
    const lines = m.state.lines.filter(l => l.startsWith('[Shared] Could not check'));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`[Shared] Could not check ${m.keyOf('row.json')} against the database (`)).toBe(true);
    expect(m.read('row.json')).toBe(text({ v: 1 }));
  });
});

describe('a mirror whose stat or read fails is unreadable, never absent', () => {
  it('a stat that fails with EACCES moves the mirror aside', async () => {
    seedLoose('st.json', 'loose bytes');
    failCall('lstatSync', m.file('st.json'), errno('EACCES'), 1);
    const res = await sm.applySharedKeys([m.keyOf('st.json')]);
    expect(res.answered).toBe(true);
    expect(fs.existsSync(m.file('st.json'))).toBe(false);
    expect(Object.values(m.superseded())).toEqual(['loose bytes']);
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Moved'))).toHaveLength(1);
    expect(m.state.lines.some(l => l.includes('pass over the shared files stopped'))).toBe(false);
  });

  it('a stat that throws a bare undefined moves the mirror aside too', async () => {
    seedLoose('stu.json', 'loose bytes');
    failCall('lstatSync', m.file('stu.json'), undefined, 1);
    const res = await sm.applySharedKeys([m.keyOf('stu.json')]);
    expect(res.answered).toBe(true);
    expect(Object.values(m.superseded())).toEqual(['loose bytes']);
    expect(m.state.lines.some(l => l.includes('pass over the shared files stopped'))).toBe(false);
  });

  it('an unreadable mirror is not taken as a row whose stored sha is empty', async () => {
    seedLoose('se.json', 'loose bytes');
    putRow('se.json', 'row bytes', '');
    failCall('lstatSync', m.file('se.json'), errno('EACCES'), 1);
    await sm.applySharedKeys([m.keyOf('se.json')]);
    expect(Object.values(m.superseded())).toEqual(['loose bytes']);
    expect(m.read('se.json')).toBe('row bytes');
  });

  it('a read that fails with EACCES moves the mirror aside', async () => {
    seedLoose('rd.json', 'loose bytes');
    failCall('readFileSync', m.file('rd.json'), errno('EACCES'), 1);
    const res = await sm.applySharedKeys([m.keyOf('rd.json')]);
    expect(res.answered).toBe(true);
    expect(fs.existsSync(m.file('rd.json'))).toBe(false);
    expect(Object.values(m.superseded())).toEqual(['loose bytes']);
  });

  it('a read that throws a bare undefined moves the mirror aside too', async () => {
    seedLoose('rdu.json', 'loose bytes');
    failCall('readFileSync', m.file('rdu.json'), undefined, 1);
    const res = await sm.applySharedKeys([m.keyOf('rdu.json')]);
    expect(res.answered).toBe(true);
    expect(Object.values(m.superseded())).toEqual(['loose bytes']);
    expect(m.state.lines.some(l => l.includes('pass over the shared files stopped'))).toBe(false);
  });

  it('an unreadable mirror keeps no stamp, even matched to a row whose stored sha reads "unreadable"', async () => {
    seedLoose('ur.json', 'loose bytes');
    putRow('ur.json', 'row bytes', 'unreadable');
    freezeNow(() => T0 + 3_600_000);
    failCall('readFileSync', m.file('ur.json'), errno('EACCES'));
    await sm.applySharedKeys([m.keyOf('ur.json')]);
    expect(m.entry('ur.json')).toEqual({ sha: 'unreadable', stamp: null, main: null });
  });

  it('an unreadable App Store mirror is logged and left as it is', async () => {
    const key = 'global/appstore/ra61.json';
    const file = dataPath('global', 'appstore', 'ra61.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'store bytes');
    failCall('readFileSync', file, errno('EACCES'));
    await sm.applySharedKeys([key]);
    vi.restoreAllMocks();
    expect(fs.readFileSync(file, 'utf8')).toBe('store bytes');
    expect(m.superseded()).toEqual({});
    expect(m.state.lines).toContain(`[Shared] Could not write ${file} (unreadable); retrying`);
  });
});

describe("decision 49's stamp: kept only when the file stood still during the hash and is 2 s old", () => {
  const N = T0;
  async function stampAfter(times: { m: number; c: number }, changeDuringHash = false): Promise<{ kept: string | null; expected: string }> {
    await m.landed('stamp.json', { v: 1 });
    expect(m.entry('stamp.json')?.stamp).toBeNull();
    const file = m.file('stamp.json');
    const real = fs.lstatSync(file);
    let hashed = false;
    const fake = () => Object.assign(Object.create(Object.getPrototypeOf(real)), real, { mtimeMs: N - times.m, ctimeMs: N - times.c, size: hashed && changeDuringHash ? real.size + 1 : real.size });
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => (same(String(args[0]), file) ? fake() : realFs().lstatSync(...args))) as any);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      const out = realFs().readFileSync(...args);
      if (same(String(args[0]), file)) hashed = true;
      return out;
    }) as any);
    freezeNow(() => N);
    const res = await sm.applySharedKeys([m.keyOf('stamp.json')]);
    expect(res.answered).toBe(true);
    const kept = m.entry('stamp.json')!.stamp;
    vi.restoreAllMocks();
    return { kept, expected: `${N - times.m}:${N - times.c}:${real.size}:${real.ino}` };
  }

  it('a file whose times are both past 2 s keeps its stamp', async () => {
    const { kept, expected } = await stampAfter({ m: 5000, c: 5000 });
    expect(kept).toBe(expected);
  });

  it('a file modified 1 s ago keeps none, though its ctime is old', async () => {
    const { kept } = await stampAfter({ m: 1000, c: 5000 });
    expect(kept).toBeNull();
  });

  it('a file whose ctime is 1 s old keeps none, though its mtime is old', async () => {
    const { kept } = await stampAfter({ m: 5000, c: 1000 });
    expect(kept).toBeNull();
  });

  it('an mtime exactly 2 s old counts as settled', async () => {
    const { kept, expected } = await stampAfter({ m: 2000, c: 5000 });
    expect(kept).toBe(expected);
  });

  it('a ctime exactly 2 s old counts as settled', async () => {
    const { kept, expected } = await stampAfter({ m: 5000, c: 2000 });
    expect(kept).toBe(expected);
  });

  it('a file that changed during the hash keeps none, though both times are old', async () => {
    const { kept } = await stampAfter({ m: 5000, c: 5000 }, true);
    expect(kept).toBeNull();
  });
});

describe('the move aside into _superseded', () => {
  it('three moves of one key in one millisecond keep all three versions, at -1 and -2', async () => {
    await m.landed('mv.json', { v: 1 });
    freezeNow(() => T0);
    const kept: Record<string, string> = {};
    const dirs = [`shared-${T0}`, `shared-${T0}-1`, `shared-${T0}-2`];
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(m.file('mv.json'), `edit ${i}`);
      m.state.rows.put(m.keyOf('mv.json'), text({ v: i + 1 }));
      await sm.applySharedKeys([m.keyOf('mv.json')]);
      expect(m.read('mv.json')).toBe(text({ v: i + 1 }));
      kept[`${dirs[i - 1]}/global/ra61/mv.json`] = `edit ${i}`;
      expect(m.superseded()).toEqual(kept);
    }
    const dest = (dir: string) => path.join(dataPath('_superseded'), dir, 'global', 'ra61', 'mv.json');
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Moved'))).toEqual([
      T11.a(m.file('mv.json'), dest(`shared-${T0}`)) + T11.written,
      T11.a(m.file('mv.json'), dest(`shared-${T0}-1`)) + T11.written,
      T11.a(m.file('mv.json'), dest(`shared-${T0}-2`)) + T11.written,
    ]);
  });

  it('a move that fails is logged once per errno, and again after a move between them succeeded', async () => {
    await m.landed('ml.json', { v: 1 });
    const failLine = `[Shared] Could not move ${m.file('ml.json')} aside (EACCES); left it as it is and will try again at the next pass`;
    fs.writeFileSync(m.file('ml.json'), 'edit 1');
    m.state.rows.put(m.keyOf('ml.json'), text({ v: 2 }));
    failCall('renameSync', m.file('ml.json'), errno('EACCES'), 2);
    await sm.applySharedKeys([m.keyOf('ml.json')]);
    await sm.applySharedKeys([m.keyOf('ml.json')]);
    expect(m.state.lines.filter(l => l === failLine)).toHaveLength(1);
    vi.mocked(fs.renameSync).mockRestore();
    await sm.applySharedKeys([m.keyOf('ml.json')]);
    expect(m.read('ml.json')).toBe(text({ v: 2 }));
    fs.writeFileSync(m.file('ml.json'), 'edit 2');
    m.state.rows.put(m.keyOf('ml.json'), text({ v: 3 }));
    failCall('renameSync', m.file('ml.json'), errno('EACCES'), 1);
    await sm.applySharedKeys([m.keyOf('ml.json')]);
    expect(m.state.lines.filter(l => l === failLine)).toHaveLength(2);
    expect(m.read('ml.json')).toBe('edit 2');
  });

  it('a rename that throws a bare undefined is logged as the move failing, and the mirror stays', async () => {
    await m.landed('mu.json', { v: 1 });
    fs.writeFileSync(m.file('mu.json'), 'edit 1');
    m.state.rows.put(m.keyOf('mu.json'), text({ v: 2 }));
    failCall('renameSync', m.file('mu.json'), undefined, 1);
    await sm.applySharedKeys([m.keyOf('mu.json')]);
    expect(m.state.lines).toContain(`[Shared] Could not move ${m.file('mu.json')} aside (undefined); left it as it is and will try again at the next pass`);
    expect(m.state.lines.some(l => l.includes('pass over the shared files stopped'))).toBe(false);
    expect(m.read('mu.json')).toBe('edit 1');
  });

  it("T11 (b) after a switch to a main with no machine name leaves the machine blank", async () => {
    await m.landed('tb.json', { v: 1 });
    expect(m.entry('tb.json')?.main).toBeNull();
    setView(3, null);
    m.state.rows.put(m.keyOf('tb.json'), text({ v: 2 }));
    await sm.applySharedKeys([m.keyOf('tb.json')]);
    expect(m.read('tb.json')).toBe(text({ v: 2 }));
    const moved = Object.keys(m.superseded());
    expect(moved).toHaveLength(1);
    const dest = path.join(dataPath('_superseded'), ...moved[0].split('/'));
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Moved'))).toEqual([T11.b(m.file('tb.json'), dest, '', 3) + T11.written]);
    expect(m.entry('tb.json')).toMatchObject({ sha: sha(text({ v: 2 })), main: '3:' });
  });
});

describe("decision 24's prune of shared_ops", () => {
  async function settledPass(at: number): Promise<void> {
    freezeNow(() => at);
    const res = await sm.runSharedPass();
    expect(res.answered).toBe(true);
    vi.mocked(Date.now).mockRestore();
    const sent = () => m.sql();
    await vi.waitFor(() => {
      const i = sent().lastIndexOf("DELETE FROM smdb_data.shared_ops WHERE at < now() - interval '7 days'");
      if (i >= 0) expect(sent().slice(i + 1).some(s => /^(COMMIT|ROLLBACK)/.test(s))).toBe(true);
    });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  }

  it('runs at most once an hour: not again after 30 min, again after 61 min', async () => {
    await settledPass(T0);
    expect(m.state.rows.prunes).toHaveLength(1);
    await settledPass(T0 + 1000);
    await settledPass(T0 + 30 * 60_000);
    expect(m.state.rows.prunes).toHaveLength(1);
    await settledPass(T0 + 61 * 60_000);
    expect(m.state.rows.prunes).toHaveLength(2);
  });
});
