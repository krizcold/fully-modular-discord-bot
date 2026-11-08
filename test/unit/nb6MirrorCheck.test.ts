import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readDocRecord, writeDocRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { mirrorRig, T11, text } from '../helpers/nb6Mirror';
import { sha } from '../helpers/sharedRows';

// NB6 test 33 (wip-redesign/sheets/NB6.md: rows 92 to 97 of round 1, rows 32, 35, 44, 94 and 96 as round 2 changes
// them, rows 154 to 156 and 159 to 161; decisions 21 and 49; part 8): the mirror check of the pass, its stamp and the
// racy-clean rule, the moves aside, and a property over edits made between passes.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6check');
const moves = () => m.state.lines.filter(l => l.startsWith('[Shared] Moved'));
const destOf = (rel: string) => path.join(dataPath('_superseded'), ...rel.split('/'));
const stampOf = (file: string) => {
  const st = fs.lstatSync(file);
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
};

/** Reads of a file by the pass, counted through the forwarding fs. */
function readsOf(file: string): () => number {
  const spy = vi.spyOn(fs, 'readFileSync');
  return () => spy.mock.calls.filter(c => path.resolve(String(c[0])) === path.resolve(file)).length;
}

/** The clock 5 s on, so every file written so far is older than the racy-clean rule's 2 s. */
function later(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 5000);
}

/** A first version written by the real flush, then given its stamp by a pass. */
async function stamped(name: string, value: unknown): Promise<string> {
  await m.landed(name, value);
  later();
  await runSharedPass();
  const stamp = m.entry(name)?.stamp;
  expect(stamp).toBe(stampOf(m.file(name)));
  return stamp!;
}

beforeEach(() => m.setup());
afterEach(() => m.teardown());

describe('rows 92 and 93: the stamp', () => {
  it('row 92: an unchanged stamp means no hash; the entry is compared with the row', async () => {
    await stamped('r92.json', { v: 1 });
    const reads = readsOf(m.file('r92.json'));
    await runSharedPass();
    expect(reads()).toBe(0);
    expect(m.read('r92.json')).toBe(text({ v: 1 }));
    expect(moves()).toEqual([]);
  });

  it('row 93: a changed stamp over the same content rewrites the stamp only', async () => {
    const before = await stamped('r93.json', { v: 1 });
    const st = fs.statSync(m.file('r93.json'));
    fs.utimesSync(m.file('r93.json'), st.atime, new Date(st.mtimeMs - 60_000));
    await runSharedPass();
    const after = m.entry('r93.json')!.stamp;
    expect(after).not.toBe(before);
    expect(after).toBe(stampOf(m.file('r93.json')));
    expect(m.entry('r93.json')!.sha).toBe(sha(text({ v: 1 })));
    expect(moves()).toEqual([]);
  });
});

describe('rows 94 to 97 and 154: content that differs from the entry', () => {
  it('row 94: a row with another sha: moved aside, the row written, T11 (a) written', async () => {
    await m.landed('r94.json', { v: 1 });
    fs.writeFileSync(m.file('r94.json'), 'hand edit');
    m.state.rows.put(m.keyOf('r94.json'), text({ v: 2 }));
    await runSharedPass();
    expect(m.read('r94.json')).toBe(text({ v: 2 }));
    const [rel, body] = Object.entries(m.superseded())[0];
    expect(body).toBe('hand edit');
    expect(moves()).toEqual([T11.a(m.file('r94.json'), destOf(rel)) + T11.written]);
  });

  it('row 154: the entry equal to the row: moved aside, the row\'s version written back', async () => {
    await m.landed('r154.json', { v: 1 });
    fs.writeFileSync(m.file('r154.json'), 'hand edit');
    await runSharedPass();
    expect(m.read('r154.json')).toBe(text({ v: 1 }));
    const [rel] = Object.keys(m.superseded());
    expect(moves()).toEqual([T11.a(m.file('r154.json'), destOf(rel)) + T11.written]);
  });

  it('row 95: content equal to the row: the entry only', async () => {
    await m.landed('r95.json', { v: 1 });
    m.state.rows.put(m.keyOf('r95.json'), text({ v: 2 }));
    fs.writeFileSync(m.file('r95.json'), text({ v: 2 }));
    await runSharedPass();
    expect(m.entry('r95.json')!.sha).toBe(sha(text({ v: 2 })));
    expect(m.superseded()).toEqual({});
    expect(moves()).toEqual([]);
  });

  it('row 96: no row: moved aside, the entry dropped, T11 (a) no row', async () => {
    await m.landed('r96.json', { v: 1 });
    fs.writeFileSync(m.file('r96.json'), 'hand edit');
    m.state.rows.docs.delete(m.keyOf('r96.json'));
    await runSharedPass();
    expect(fs.existsSync(m.file('r96.json'))).toBe(false);
    expect(m.entry('r96.json')).toBeUndefined();
    const [rel] = Object.keys(m.superseded());
    expect(moves()).toEqual([T11.a(m.file('r96.json'), destOf(rel)) + T11.noRow]);
  });

  it('row 97: a move aside that fails writes nothing for the key and is logged once per path and errno', async () => {
    await m.landed('r97.json', { v: 1 });
    fs.writeFileSync(m.file('r97.json'), 'hand edit');
    m.state.rows.put(m.keyOf('r97.json'), text({ v: 2 }));
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(from)) === path.resolve(m.file('r97.json'))) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return real(from, to);
    });
    await runSharedPass();
    await runSharedPass();
    expect(m.read('r97.json')).toBe('hand edit');
    expect(m.entry('r97.json')!.sha).toBe(sha(text({ v: 1 })));
    expect(m.state.lines.filter(l => l.startsWith('[Shared] Could not move'))).toEqual([
      `[Shared] Could not move ${m.file('r97.json')} aside (EBUSY); left it as it is and will try again at the next pass`,
    ]);
    spy.mockRestore();
    await runSharedPass();
    expect(m.read('r97.json')).toBe(text({ v: 2 }));
  });
});

describe('rows 155 and 156: after a rename', () => {
  it('row 155: the mirror absent with the entry equal to the row: the row written, no T11', async () => {
    await m.landed('r155.json', { v: 1 });
    fs.rmSync(m.file('r155.json'));
    await runSharedPass();
    expect(m.read('r155.json')).toBe(text({ v: 1 }));
    expect(moves()).toEqual([]);
  });

  it('row 156: the write after a rename fails: the mirror stays absent, the entry unchanged, the next pass writes', async () => {
    await m.landed('r156.json', { v: 1 });
    fs.writeFileSync(m.file('r156.json'), 'hand edit');
    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    await runSharedPass();
    expect(fs.existsSync(m.file('r156.json'))).toBe(false);
    expect(m.entry('r156.json')!.sha).toBe(sha(text({ v: 1 })));
    const [rel] = Object.keys(m.superseded());
    expect(moves()).toEqual([T11.a(m.file('r156.json'), destOf(rel)) + T11.writeFailed('ENOSPC')]);
    await runSharedPass();
    expect(m.read('r156.json')).toBe(text({ v: 1 }));
    expect(moves()).toHaveLength(1);
  });
});

describe('rows 159 to 161: the racy-clean rule', () => {
  it('row 159: a same-size rewrite on the same inode with the mtime put back changes the ctime: hashed, moved aside', async () => {
    await stamped('r159.json', { v: 1 });
    const st = fs.statSync(m.file('r159.json'));
    const same = text({ v: 9 });
    expect(same.length).toBe(text({ v: 1 }).length);
    await new Promise(resolve => setTimeout(resolve, 15));
    fs.writeFileSync(m.file('r159.json'), same);
    fs.utimesSync(m.file('r159.json'), st.atime, st.mtime);
    expect(fs.statSync(m.file('r159.json')).ino).toBe(st.ino);
    await runSharedPass();
    expect(m.read('r159.json')).toBe(text({ v: 1 }));
    expect(Object.values(m.superseded())).toEqual([same]);
  });

  it('row 160: a file hashed within 2 s of its change keeps a null stamp and is hashed again', async () => {
    await m.landed('r160.json', { v: 1 });
    await runSharedPass();
    expect(m.entry('r160.json')!.stamp).toBeNull();
    const reads = readsOf(m.file('r160.json'));
    await runSharedPass();
    expect(reads()).toBe(1);
  });

  it('row 161: step 5 hashes the bytes before it replaces, though the stamp matched: an edit the stamp missed is moved aside', async () => {
    await m.landed('r161.json', { v: 1 });
    fs.writeFileSync(m.file('r161.json'), 'edit the stamp missed');
    later();
    const record = readDocRecord();
    if (!record.ok) throw new Error(record.reason);
    record.record.docs[m.keyOf('r161.json')] = { ...record.record.docs[m.keyOf('r161.json')], stamp: stampOf(m.file('r161.json')) };
    writeDocRecord(record.record);
    m.state.rows.put(m.keyOf('r161.json'), text({ v: 2 }));
    await runSharedPass();
    expect(m.read('r161.json')).toBe(text({ v: 2 }));
    expect(Object.values(m.superseded())).toEqual(['edit the stamp missed']);
    const [rel] = Object.keys(m.superseded());
    expect(moves()).toEqual([T11.a(m.file('r161.json'), destOf(rel)) + T11.written]);
  });
});

describe('the property: edits between passes', () => {
  type Act = { kind: 'edit'; k: number; body: string } | { kind: 'delete'; k: number } | { kind: 'rename'; k: number } | { kind: 'restamp'; k: number };
  const KEYS = ['p0.json', 'p1.json', 'p2.json'];
  const act: fc.Arbitrary<Act> = fc.oneof(
    fc.record({ kind: fc.constant('edit' as const), k: fc.integer({ min: 0, max: 2 }), body: fc.string({ minLength: 1, maxLength: 12 }) }),
    fc.record({ kind: fc.constant('delete' as const), k: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant('rename' as const), k: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant('restamp' as const), k: fc.integer({ min: 0, max: 2 }) }),
  );

  it('after one full-rehash pass every mirror equals its row, and every byte sequence that differed is in _superseded', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(act, { maxLength: 8 }), async acts => {
      run += 1;
      await m.teardown();
      await m.setup();
      KEYS.forEach((k, i) => m.state.rows.put(m.keyOf(k), text({ k: i, run })));
      await runSharedPass({ rehash: true });
      for (const a of acts) {
        const f = m.file(KEYS[a.k]);
        if (a.kind === 'edit') fs.writeFileSync(f, a.body);
        else if (a.kind === 'delete') fs.rmSync(f, { force: true });
        else if (a.kind === 'rename' && fs.existsSync(f)) fs.renameSync(f, m.file(`moved-${a.k}-${run}.json`));
        else if (a.kind === 'restamp' && fs.existsSync(f)) {
          const st = fs.statSync(f);
          const body = fs.readFileSync(f);
          fs.writeFileSync(f, Buffer.alloc(body.length, 0x41));
          fs.utimesSync(f, st.atime, st.mtime);
        }
      }
      const dir = path.dirname(m.file('x'));
      const differing: string[] = [];
      for (const name of fs.readdirSync(dir)) {
        const body = fs.readFileSync(path.join(dir, name), 'utf8');
        const row = m.state.rows.docs.get(m.keyOf(name));
        if (!row || row.body.toString('utf8') !== body) differing.push(body);
      }
      await runSharedPass({ rehash: true });
      for (const k of KEYS) expect(m.read(k)).toBe(m.state.rows.docs.get(m.keyOf(k))!.body.toString('utf8'));
      expect(fs.readdirSync(dir).sort()).toEqual([...KEYS].sort());
      const aside = Object.values(m.superseded());
      for (const body of differing) expect(aside).toContain(body);
    }), { numRuns: 25 });
  });
});
