import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { onSharedApplied } from '../../src/bot/internalSetup/utils/dataManager';
import { runSharedPass, stopSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { docRecordPath } from '../../src/bot/internalSetup/utils/sharedRecords';
import { mirrorRig, setView, T11, text } from '../helpers/nb6Mirror';
import { pgError, sha } from '../helpers/sharedRows';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('ra63');
const LIST = 'SELECT key, sha FROM smdb_data.shared_docs';
const BODY = 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1';
const moves = () => m.state.lines.filter(l => l.startsWith('[Shared] Moved'));
const writeFails = () => m.state.lines.filter(l => l.startsWith('[Shared] Could not write'));
const destOf = (rel: string) => path.join(dataPath('_superseded'), ...rel.split('/'));
const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
const timeout = () => pgError('57014', 'canceling statement due to statement timeout');

let unhook: (() => void) | null = null;
let applied: string[] = [];

beforeEach(async () => {
  await m.setup();
  applied = [];
  unhook = onSharedApplied('global/ra63/', key => { applied.push(key); });
});
afterEach(async () => {
  unhook?.();
  unhook = null;
  await m.teardown();
});

function bodyReads(): number {
  return m.sql().filter(s => s === BODY).length;
}

function recordRenames(): () => number {
  const spy = vi.spyOn(fs, 'renameSync');
  return () => spy.mock.calls.filter(c => same(String(c[1]), docRecordPath())).length;
}

/** After the first rename of the mirror away from its path, another writer puts a file there. */
function refillAfterMove(file: string, content: string): void {
  const real = fs.renameSync;
  let done = false;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    real(from, to);
    if (!done && same(String(from), file)) {
      done = true;
      fs.writeFileSync(file, content);
    }
  });
}

function later(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 5000);
}

async function stamped(name: string, value: unknown): Promise<string> {
  await m.landed(name, value);
  later();
  await runSharedPass();
  const stamp = m.entry(name)?.stamp;
  expect(typeof stamp).toBe('string');
  m.state.pg.sent.length = 0;
  return stamp!;
}

describe('ra63: a pass that finds nothing to change writes no record', () => {
  it('an unchanged, settled mirror leaves the record file alone', async () => {
    const stamp = await stamped('quiet.json', { v: 1 });
    const renames = recordRenames();
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(renames()).toBe(0);
    expect(m.entry('quiet.json')).toEqual({ sha: sha(text({ v: 1 })), stamp, main: null });
  });

  it('a touched mirror whose new stamp is too recent to keep leaves the entry and the record as they were', async () => {
    const stamp = await stamped('racy.json', { v: 1 });
    const st = fs.statSync(m.file('racy.json'));
    fs.utimesSync(m.file('racy.json'), st.atime, new Date(Date.now()));
    const renames = recordRenames();
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(renames()).toBe(0);
    expect(m.entry('racy.json')).toEqual({ sha: sha(text({ v: 1 })), stamp, main: null });
  });
});

describe('ra63: a main that changes during the pass writes nothing for the key', () => {
  it('an entry from an older main keeps its tag when the main moves again', async () => {
    setView(1, 'ALPHA');
    await m.landed('tag3.json', { v: 1 });
    setView(2, 'BRAVO');
    m.state.rows.fault = sql => {
      if (sql === LIST) setView(3, 'CHARLIE');
      return undefined;
    };
    await runSharedPass();
    expect(m.entry('tag3.json')).toMatchObject({ sha: sha(text({ v: 1 })), main: '1:ALPHA' });
    expect(m.read('tag3.json')).toBe(text({ v: 1 }));
  });

  it('a mirror already equal to the row does not take the row into its entry', async () => {
    setView(1, 'ALPHA');
    await m.landed('tag95.json', { v: 1 });
    m.state.rows.put(m.keyOf('tag95.json'), text({ v: 2 }));
    fs.writeFileSync(m.file('tag95.json'), text({ v: 2 }));
    m.state.rows.fault = sql => {
      if (sql === LIST) setView(2, 'BRAVO');
      return undefined;
    };
    await runSharedPass();
    expect(m.entry('tag95.json')).toMatchObject({ sha: sha(text({ v: 1 })), main: '1:ALPHA' });
  });

  it('a hand edit with no row is moved aside but its entry is kept', async () => {
    setView(1, 'ALPHA');
    await m.landed('tag96.json', { v: 1 });
    fs.writeFileSync(m.file('tag96.json'), 'hand edit');
    m.state.rows.docs.delete(m.keyOf('tag96.json'));
    m.state.rows.fault = sql => {
      if (sql === LIST) setView(2, 'BRAVO');
      return undefined;
    };
    await runSharedPass();
    expect(m.entry('tag96.json')).toEqual(expect.objectContaining({ sha: sha(text({ v: 1 })), main: '1:ALPHA' }));
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe('hand edit');
    expect(moves()).toContain(T11.a(m.file('tag96.json'), destOf(rel)) + T11.tagChanged);
  });
});

describe('ra63: a mirror and a row both gone', () => {
  it('drops the entry', async () => {
    await m.landed('gone.json', { v: 1 });
    fs.rmSync(m.file('gone.json'));
    m.state.rows.docs.delete(m.keyOf('gone.json'));
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(m.entry('gone.json')).toBeUndefined();
    expect(m.read('gone.json')).toBeNull();
  });
});

describe('ra63: a move aside with no row in the listing', () => {
  it('a mirror from an older main with no row: moved, entry dropped, hooks run, no body read', async () => {
    setView(1, 'ALPHA');
    await m.landed('oldmain.json', { v: 1 });
    setView(2, 'BRAVO');
    m.state.rows.docs.delete(m.keyOf('oldmain.json'));
    m.state.rows.fault = sql => {
      if (sql === BODY) m.state.rows.put(m.keyOf('oldmain.json'), text({ v: 9 }));
      return undefined;
    };
    await runSharedPass();
    expect(bodyReads()).toBe(0);
    expect(m.read('oldmain.json')).toBeNull();
    expect(m.entry('oldmain.json')).toBeUndefined();
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe(text({ v: 1 }));
    expect(moves()).toEqual([T11.b(m.file('oldmain.json'), destOf(rel), 'BRAVO', 2) + T11.noRow]);
    expect(applied).toEqual([m.keyOf('oldmain.json')]);
  });

  it('a hand-placed file with no row and no entry: moved, hooks run, no body read', async () => {
    fs.mkdirSync(path.dirname(m.file('placed.json')), { recursive: true });
    fs.writeFileSync(m.file('placed.json'), 'placed by hand');
    m.state.rows.fault = sql => {
      if (sql === BODY) m.state.rows.put(m.keyOf('placed.json'), text({ v: 9 }));
      return undefined;
    };
    await runSharedPass();
    expect(bodyReads()).toBe(0);
    expect(m.read('placed.json')).toBeNull();
    expect(m.entry('placed.json')).toBeUndefined();
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe('placed by hand');
    expect(moves()).toEqual([T11.a(m.file('placed.json'), destOf(rel)) + T11.noRow]);
    expect(applied).toEqual([m.keyOf('placed.json')]);
  });
});

describe('ra63: a row that changes between the reads of one pass', () => {
  it('a row gone at the first read and back at the second: the second read\'s version is written', async () => {
    await m.landed('flip.json', { v: 1 });
    m.state.rows.put(m.keyOf('flip.json'), text({ v: 2 }));
    let reads = 0;
    m.state.rows.fault = sql => {
      if (sql !== BODY) return undefined;
      reads += 1;
      if (reads === 1) m.state.rows.docs.delete(m.keyOf('flip.json'));
      else m.state.rows.put(m.keyOf('flip.json'), text({ v: 3 }));
      return undefined;
    };
    await runSharedPass();
    expect(reads).toBe(2);
    expect(m.read('flip.json')).toBe(text({ v: 3 }));
    expect(m.entry('flip.json')).toMatchObject({ sha: sha(text({ v: 3 })) });
  });

  it('a row back at the entry\'s version by the second read: the mirror and its stamp are left alone', async () => {
    const stamp = await stamped('back.json', { v: 1 });
    const ino = fs.statSync(m.file('back.json')).ino;
    m.state.rows.put(m.keyOf('back.json'), text({ v: 2 }));
    let reads = 0;
    m.state.rows.fault = sql => {
      if (sql !== BODY) return undefined;
      reads += 1;
      if (reads === 1) m.state.rows.docs.delete(m.keyOf('back.json'));
      else m.state.rows.put(m.keyOf('back.json'), text({ v: 1 }));
      return undefined;
    };
    await runSharedPass();
    expect(reads).toBe(2);
    expect(m.entry('back.json')).toEqual({ sha: sha(text({ v: 1 })), stamp, main: null });
    expect(fs.statSync(m.file('back.json')).ino).toBe(ino);
    expect(applied).toEqual([]);
  });

  it('a mirror removed during the read is not moved aside; the row is written', async () => {
    await m.landed('vanish.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('vanish.json'));
    m.state.rows.fault = sql => {
      if (sql === BODY) {
        fs.rmSync(m.file('vanish.json'));
        m.state.rows.put(m.keyOf('vanish.json'), text({ v: 3 }));
      }
      return undefined;
    };
    await runSharedPass();
    expect(m.read('vanish.json')).toBe(text({ v: 3 }));
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Could not move'))).toEqual([]);
  });

  it('a mirror rewritten during the read with no row: moved aside, the entry dropped, hooks run', async () => {
    await m.landed('rewrit.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('rewrit.json'));
    m.state.rows.fault = sql => {
      if (sql === BODY) fs.writeFileSync(m.file('rewrit.json'), 'other');
      return undefined;
    };
    await runSharedPass();
    expect(m.read('rewrit.json')).toBeNull();
    expect(m.entry('rewrit.json')).toBeUndefined();
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe('other');
    expect(moves()).toEqual([T11.a(m.file('rewrit.json'), destOf(rel)) + T11.noRow]);
    expect(applied).toEqual([m.keyOf('rewrit.json')]);
  });

  it('a file placed again right after that move is not removed', async () => {
    await m.landed('again.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('again.json'));
    m.state.rows.fault = sql => {
      if (sql === BODY) fs.writeFileSync(m.file('again.json'), 'other');
      return undefined;
    };
    refillAfterMove(m.file('again.json'), 'placed again');
    await runSharedPass();
    expect(m.read('again.json')).toBe('placed again');
    expect(Object.values(m.superseded())).toEqual(['other']);
  });

  it('a file that arrives right after the mirror was found absent is not removed', async () => {
    await m.landed('arrive.json', { v: 1 });
    fs.rmSync(m.file('arrive.json'));
    let armed = false;
    m.state.rows.fault = sql => {
      if (sql === BODY) {
        m.state.rows.docs.delete(m.keyOf('arrive.json'));
        armed = true;
      }
      return undefined;
    };
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (armed && same(String(p), m.file('arrive.json'))) {
        armed = false;
        try {
          return (real as any)(p, ...rest);
        } catch (error) {
          fs.writeFileSync(m.file('arrive.json'), 'arrived');
          throw error;
        }
      }
      return (real as any)(p, ...rest);
    }) as any);
    await runSharedPass();
    expect(m.read('arrive.json')).toBe('arrived');
    expect(m.entry('arrive.json')).toBeUndefined();
  });

  it('a second move after a move from an older main keeps T11 (b)\'s head', async () => {
    setView(1, 'ALPHA');
    await m.landed('twice.json', { v: 1 });
    setView(2, 'BRAVO');
    m.state.rows.put(m.keyOf('twice.json'), text({ v: 'bravo' }));
    refillAfterMove(m.file('twice.json'), 'reappeared');
    await runSharedPass();
    expect(m.read('twice.json')).toBe(text({ v: 'bravo' }));
    const all = m.superseded();
    expect(Object.values(all).sort()).toEqual([text({ v: 1 }), 'reappeared'].sort());
    const first = Object.keys(all).find(k => all[k] === text({ v: 1 }))!;
    expect(moves()).toEqual([T11.b(m.file('twice.json'), destOf(first), 'BRAVO', 2) + T11.written]);
  });
});

describe('ra63: the read at step 5 fails or the pass stops during it', () => {
  it('a mirror equal to its entry is kept when the read fails', async () => {
    await m.landed('readfail.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('readfail.json'));
    m.state.rows.fault = sql => (sql === BODY ? timeout() : undefined);
    const res = await runSharedPass();
    expect(res.answered).toBe(false);
    expect(res.cause).toContain('statement timeout');
    expect(m.read('readfail.json')).toBe(text({ v: 1 }));
    expect(m.entry('readfail.json')).toMatchObject({ sha: sha(text({ v: 1 })) });
  });

  it('a mirror moved aside before a failed read gets T11 (a) with the write-failed tail', async () => {
    await m.landed('movedfail.json', { v: 1 });
    fs.writeFileSync(m.file('movedfail.json'), 'hand edit');
    m.state.rows.fault = sql => (sql === BODY ? timeout() : undefined);
    await runSharedPass();
    const [rel] = Object.keys(m.superseded());
    const lines = moves();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(T11.a(m.file('movedfail.json'), destOf(rel)) + "the database's version could not be written (")).toBe(true);
    expect(lines[0]).toContain('statement timeout');
  });

  it('a stop during the read of an absent mirror writes nothing', async () => {
    await m.landed('halt.json', { v: 1 });
    fs.rmSync(m.file('halt.json'));
    m.state.rows.fault = sql => {
      if (sql === BODY) stopSharedPass();
      return undefined;
    };
    const res = await runSharedPass();
    expect(res).toEqual({ answered: false, cause: null });
    expect(m.read('halt.json')).toBeNull();
    expect(m.entry('halt.json')).toMatchObject({ sha: sha(text({ v: 1 })) });
  });
});

describe('ra63: the removal of a mirror whose row is gone', () => {
  function failUnlink(file: string, act: (real: typeof fs.unlinkSync, p: fs.PathLike) => void): void {
    const real = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(p => {
      if (same(String(p), file)) act(real, p);
      else real(p);
    });
  }

  it('a removal that fails keeps the file and its entry and logs the write failure once', async () => {
    await m.landed('eperm.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('eperm.json'));
    failUnlink(m.file('eperm.json'), () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    await runSharedPass();
    expect(m.read('eperm.json')).toBe(text({ v: 1 }));
    expect(m.entry('eperm.json')).toMatchObject({ sha: sha(text({ v: 1 })) });
    expect(writeFails()).toEqual([`[Shared] Could not write ${m.file('eperm.json')} (EPERM); retrying`]);
  });

  it('a file already gone at the removal: the entry is dropped and no failure is logged', async () => {
    await m.landed('enoent.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('enoent.json'));
    failUnlink(m.file('enoent.json'), (real, p) => {
      real(p);
      real(p);
    });
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(m.read('enoent.json')).toBeNull();
    expect(m.entry('enoent.json')).toBeUndefined();
    expect(writeFails()).toEqual([]);
  });

  it('a removal that throws no error object is logged as a write failure and the pass answers', async () => {
    await m.landed('nothing.json', { v: 1 });
    m.state.rows.docs.delete(m.keyOf('nothing.json'));
    failUnlink(m.file('nothing.json'), () => { throw undefined; });
    const res = await runSharedPass();
    expect(res.answered).toBe(true);
    expect(writeFails()).toEqual([`[Shared] Could not write ${m.file('nothing.json')} (undefined); retrying`]);
    expect(m.state.lines.filter(l => l.startsWith('[Shared] The pass over the shared files stopped'))).toEqual([]);
    expect(m.entry('nothing.json')).toMatchObject({ sha: sha(text({ v: 1 })) });
  });
});
