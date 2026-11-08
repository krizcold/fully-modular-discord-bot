import fs from 'fs';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { KeyTree } from '../../src/bot/internalSetup/utils/storableData';
import { _resetRowQueue, forgetGlobalTree, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

// NB6 test 12 (wip-redesign/sheets/NB6.md decision 18, NB12's F9, C12; section 5 row 2; part 4): rules K, T, the kind
// rule and P for the keys of no guild, on both backends; and a property that P over the global keys refuses exactly
// what KeyTree.check refuses.

type Backend = 'file' | 'postgres';
const BACKENDS: Backend[] = ['file', 'postgres'];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setBackendKind('file');
  await dm.flushAll();
});

function rig(backend: Backend, name: string) {
  const category = `nb6st-${name}-${backend}`;
  setBackendKind(backend);
  const o: dm.DataOptions = { scope: 'global', category };
  const file = (rel: string) => dataPath('global', category, ...rel.split('/'));
  /** Nothing of this write is held anywhere: no file op, no row op, no file. */
  const nothingHeld = (rel: string) => {
    expect(getPending(file(rel))).toBeUndefined();
    expect(rowQueue.ops(`global/${category}/${rel}`)).toEqual([]);
    expect(fs.existsSync(file(rel))).toBe(false);
  };
  return { category, o, file, nothingHeld };
}

const unstorable = (reason: string) => ({ outcome: 'refused', cause: 'unstorable', reason });

describe.each(BACKENDS)('row 2 on the %s backend', backend => {
  it('K: a name ending in .tmp is refused', async () => {
    const r = rig(backend, 'tmp');
    expect(dm.saveDataTracked('x.tmp', r.o, { v: 1 })).toEqual(unstorable('the part "x.tmp" ends in ".tmp", which marks an interrupted write'));
    await dm.flushAll();
    r.nothingHeld('x.tmp');
  });

  it('K: a name over 200 bytes is refused', async () => {
    const r = rig(backend, 'long');
    const name = `${'a'.repeat(201)}.json`;
    expect(dm.saveDataTracked(name, r.o, { v: 1 })).toEqual(unstorable(`the part "${'a'.repeat(40)}..." is 206 bytes; one part of a key holds at most 200`));
    await dm.flushAll();
    r.nothingHeld(name);
  });

  it('P: two keys that differ only in letter case', async () => {
    const r = rig(backend, 'case');
    expect(dm.saveDataTracked('a.json', r.o, { v: 1 }).outcome).toBe('saved');
    expect(dm.saveDataTracked('A.json', r.o, { v: 2 })).toEqual(unstorable(`it differs only in letter case from ${r.category}/a.json`));
    expect(dm.updateData('A.json', r.o, { v: 0 }, () => ({ v: 3 }))).toEqual(unstorable(`it differs only in letter case from ${r.category}/a.json`));
    await dm.flushAll();
    expect(rowQueue.ops(`global/${r.category}/A.json`)).toEqual([]);
    expect(getPending(r.file('A.json'))).toBeUndefined();
  });

  it('P: a file where a folder is needed, and a folder where a file is', async () => {
    const r = rig(backend, 'kind');
    expect(dm.saveDataTracked('x.json', r.o, { v: 1 }).outcome).toBe('saved');
    expect(dm.saveDataTracked('x.json/y.json', r.o, { v: 2 })).toEqual(unstorable(`the folder ${r.category}/x.json of it is a file`));
    expect(dm.saveDataTracked('d/e.json', r.o, { v: 3 }).outcome).toBe('saved');
    expect(dm.saveDataTracked('d', r.o, { v: 4 })).toEqual(unstorable(`${r.category}/d names a folder that holds other keys`));
    await dm.flushAll();
    expect(rowQueue.ops(`global/${r.category}/x.json/y.json`)).toEqual([]);
    expect(getPending(r.file('x.json/y.json'))).toBeUndefined();
  });

  it('P: the tree holds the mirror files found at the first global write', async () => {
    const r = rig(backend, 'mirror');
    setBackendKind('file');
    expect(dm.saveDataTracked('Pre.json', r.o, { v: 1 }).outcome).toBe('saved');
    await dm.flushAll();
    forgetGlobalTree();
    setBackendKind(backend);
    expect(dm.saveDataTracked('pre.json', r.o, { v: 2 })).toEqual(unstorable(`it differs only in letter case from ${r.category}/Pre.json`));
  });

  it('T and the kind rule on a raw write under /data/global and of the root config', async () => {
    const r = rig(backend, 'raw');
    expect(dm.writeRawAtomicTracked(r.file('t.json'), 'a\u0000b')).toEqual({ accepted: false, cause: 'unstorable', reason: 'it holds U+0000 at character 1' });
    expect(dm.writeRawAtomicTracked(r.file('s.json'), 'a\ud800b')).toEqual({ accepted: false, cause: 'unstorable', reason: 'it holds an unpaired surrogate (U+D800) at character 1, which no store keeps as written' });
    expect(dm.writeRawAtomicTracked(r.file('l.jsonl'), '{}\n')).toEqual({ accepted: false, cause: 'unstorable', reason: 'a .jsonl file is written by appends only' });
    expect(dm.writeRawAtomicTracked(dataPath('dist', 'bot', 'config.json'), '\u0000')).toEqual({ accepted: false, cause: 'unstorable', reason: 'it holds U+0000 at character 0' });
    await dm.flushAll();
    for (const rel of ['t.json', 's.json', 'l.jsonl']) r.nothingHeld(rel);
    expect(rowQueue.ops('config.json')).toEqual([]);
  });

  it('an append to a global key meets K and P too', async () => {
    const r = rig(backend, 'append');
    expect(dm.saveDataTracked('log.json', r.o, { v: 1 }).outcome).toBe('saved');
    expect(dm.appendDataTracked('LOG.json/x.jsonl', r.o, 'line')).toEqual(unstorable(`it differs only in letter case from ${r.category}/log.json`));
    expect(dm.appendDataTracked('x.tmp/y.jsonl', r.o, 'line')).toEqual(unstorable('the part "x.tmp" ends in ".tmp", which marks an interrupted write'));
  });
});

describe('P over the global keys is KeyTree.check (property)', () => {
  it('a facade write is refused exactly when KeyTree.check refuses its key beside the keys accepted before it', async () => {
    const seg = fc.constantFrom('a', 'A', 'b', 'a.json', 'A.json', 'b.json');
    const key = fc.array(seg, { minLength: 1, maxLength: 3 }).map(parts => parts.join('/'));
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.constantFrom<Backend>('file', 'postgres'), fc.array(key, { minLength: 1, maxLength: 6 }), async (backend, keys) => {
      const category = `nb6prop${run++}`;
      setBackendKind(backend);
      _resetRowQueue();
      forgetGlobalTree();
      const model = new KeyTree();
      for (const rel of keys) {
        const expected = model.check(`${category}/${rel}`);
        const res = dm.saveDataTracked(rel, { scope: 'global', category }, { rel });
        if (expected) {
          expect(res).toEqual(unstorable(expected.reason));
        } else {
          expect(res.outcome).toBe('saved');
          model.add(`${category}/${rel}`);
        }
      }
      setBackendKind('file');
      await dm.flushAll();
      fs.rmSync(dataPath('global', category), { recursive: true, force: true });
    }), { numRuns: 60 });
  });
});
