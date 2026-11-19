import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_ROOT } from '../../src/utils/dataRoot';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setBackendKind } from '../helpers/backendKind';

// NB38: every data entry refuses a scope that is neither 'guild' (or absent) nor 'global' before anything is read,
// queued or written, and names the scope it got.

const GUILD = '9380000000000001';
const BAD: Array<[string, unknown, string]> = [
  ['Guild', 'Guild', '"Guild"'],
  ['other', 'other', '"other"'],
  ['a cast number', 42, '42'],
  ['null', null, 'null'],
];

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        out.set(full + path.sep, '');
        visit(full);
      } else {
        out.set(full, fs.readFileSync(full, 'utf8'));
      }
    }
  };
  visit(dir);
  return out;
}

function plant(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

let errors: string[];

beforeEach(() => {
  errors = [];
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  await dm.flushAll();
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('NB38: a scope that is neither guild nor global', () => {
  const cases = BAD.flatMap(([label, scope, named]) => [
    { label: `${label} with a guild id`, scope, named, options: { guildId: GUILD } },
    { label: `${label} without a guild id`, scope, named, options: {} },
  ]);

  it.each(cases)('$label: every entry refuses before a read, queue or write, and the global folder is not reached', async ({ scope, named, options }) => {
    const planted = path.join(DATA_ROOT, 'global', 'nb38-held.json');
    plant(planted, '{"kept":true}');
    const before = tree(DATA_ROOT);
    const queuedBefore = queuedFilePaths();
    const o = { ...options, scope, category: '../global' } as unknown as dm.DataOptions;
    let ran = false;

    const saved = dm.saveDataTracked('nb38-new.json', o, { v: 1 });
    const updated = dm.updateData<{ v?: number }>('nb38-new.json', o, {}, () => {
      ran = true;
      return { v: 2 };
    });
    const appended = dm.appendDataTracked('nb38.jsonl', o, 'x\n');
    const deleted = dm.deleteDataTracked('nb38-held.json', o);
    for (const answer of [saved, updated, appended, deleted]) {
      expect(answer).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
      expect((answer as { reason: string }).reason).toContain(`data scope ${named}`);
    }
    expect(ran).toBe(false);
    expect(dm.saveData('nb38-new.json', o, { v: 1 })).toBe(false);
    expect(dm.saveDataOutcome('nb38-new.json', o, { v: 1 })).toBe('refused');
    expect(dm.appendData('nb38.jsonl', o, 'x\n')).toBe(false);
    expect(dm.deleteData('nb38-held.json', o)).toBe(false);
    expect(dm.deleteDataOutcome('nb38-held.json', o)).toBe('refused');

    errors = [];
    expect(dm.loadData('nb38-held.json', o, { fallback: true })).toEqual({ fallback: true });
    expect(errors.some(e => e.includes(`data scope ${named}`))).toBe(true);
    errors = [];
    expect(dm.dataExists('nb38-held.json', o)).toBe(false);
    expect(errors.some(e => e.includes(`data scope ${named}`))).toBe(true);

    expect(queuedFilePaths()).toEqual(queuedBefore);
    await dm.flushAll();
    expect(tree(DATA_ROOT)).toEqual(before);
    expect(fs.readFileSync(planted, 'utf8')).toBe('{"kept":true}');
    fs.rmSync(planted, { force: true });
  });

  it.each([
    ['absent', { guildId: GUILD }],
    ['guild', { guildId: GUILD, scope: 'guild' }],
    ['global', { scope: 'global' }],
  ])('scope %s: save, load, exists, append, update and delete work as before', async (_label, base) => {
    const o = { ...base, category: 'nb38' } as dm.DataOptions;
    expect(dm.saveData('nb38-ok.json', o, { v: 1 })).toBe(true);
    expect(dm.loadData('nb38-ok.json', o, null)).toEqual({ v: 1 });
    expect(dm.dataExists('nb38-ok.json', o)).toBe(true);
    expect(dm.updateData<{ v: number }>('nb38-ok.json', o, { v: 0 }, c => ({ v: c.v + 1 })).outcome).toBe('saved');
    expect(dm.appendData('nb38-ok.jsonl', o, 'x\n')).toBe(true);
    await dm.flushAll();
    expect(dm.loadData('nb38-ok.json', o, null)).toEqual({ v: 2 });
    expect(dm.deleteDataOutcome('nb38-ok.json', o)).toBe('deleted');
    expect(dm.deleteData('nb38-ok.jsonl', o)).toBe(true);
    await dm.flushAll();
    expect(dm.dataExists('nb38-ok.json', o)).toBe(false);
  });
});
