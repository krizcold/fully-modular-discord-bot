import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docRecordPath, readDocRecord, readStoreRecord, storeRecordPath } from '../../src/bot/internalSetup/utils/sharedRecords';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

function place(file: string, text: string): void {
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(docRecordPath(), { recursive: true, force: true });
  fs.rmSync(storeRecordPath(), { recursive: true, force: true });
});

describe('a mirror record that cannot be read', () => {
  it('answers why, naming the error code, when the record path is a folder', () => {
    const file = docRecordPath();
    fs.rmSync(file, { recursive: true, force: true });
    fs.mkdirSync(file, { recursive: true });
    expect(readDocRecord()).toEqual({ ok: false, reason: `${file} could not be read (EISDIR)` });
  });

  it('answers with the thrown value when the read throws something that is not an error', () => {
    const file = docRecordPath();
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (path.resolve(String(p)) === path.resolve(file)) throw null;
      return (real as any)(p, ...rest);
    }) as typeof fs.readFileSync);
    expect(readDocRecord()).toEqual({ ok: false, reason: `${file} could not be read (null)` });
  });

  it('answers an empty record when the file is absent', () => {
    fs.rmSync(docRecordPath(), { recursive: true, force: true });
    fs.rmSync(storeRecordPath(), { recursive: true, force: true });
    expect(readDocRecord()).toEqual({ ok: true, record: { docs: {} } });
    expect(readStoreRecord()).toEqual({ ok: true, record: { docs: {}, modules: {} } });
  });
});

describe('a doc mirror record whose JSON is not a record', () => {
  const refused = () => ({ ok: false, reason: `${docRecordPath()} does not hold a record` });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a number', '5'],
    ['a map with no docs', '{}'],
    ['a map whose docs is a number', '{"docs":5}'],
    ['a map whose docs is null', '{"docs":null}'],
    ['a map whose docs is an array', '{"docs":[]}'],
  ])('is refused when it holds %s', (_label, text) => {
    place(docRecordPath(), text);
    expect(readDocRecord()).toEqual(refused());
  });

  it('is read whole when it holds a docs map', () => {
    place(docRecordPath(), '{"docs":{"a.json":{"sha":"s","stamp":null,"main":"0"}}}');
    expect(readDocRecord()).toEqual({ ok: true, record: { docs: { 'a.json': { sha: 's', stamp: null, main: '0' } } } });
  });
});

describe('a store mirror record whose JSON is not a record', () => {
  const refused = () => ({ ok: false, reason: `${storeRecordPath()} does not hold a record` });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['modules with no docs', '{"modules":{}}'],
    ['docs with no modules', '{"docs":{}}'],
    ['an array for docs', '{"docs":[],"modules":{}}'],
    ['null for modules', '{"docs":{},"modules":null}'],
  ])('is refused when it holds %s', (_label, text) => {
    place(storeRecordPath(), text);
    expect(readStoreRecord()).toEqual(refused());
  });

  it('is read whole when it holds docs and modules maps', () => {
    place(storeRecordPath(), '{"docs":{},"modules":{"m":{"sha":"s"}}}');
    expect(readStoreRecord()).toEqual({ ok: true, record: { docs: {}, modules: { m: { sha: 's' } } } });
  });
});
