import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll, placeGuildWrite, setGuildViewCache } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { caseSensitiveWhereAllowed } from '../helpers/caseInsensitiveDisk';
import { REAL_FS } from '../helpers/forwardingFs';

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

// NB12 item 2 (wip-redesign/sheets/NB12.md): on a disk that keeps letter case apart, an overwrite of a stored key is
// accepted beside a folder whose name differs from it only in case and that holds keys; that folder is never removed.
// Where the host cannot keep case apart in the data folder, the row is skipped, so the skip shows in the run.

const folds = caseSensitiveWhereAllowed(dataPath());

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await flushAll();
  setGuildViewCache(false);
});

it.skipIf(folds)('an overwrite beside a case alias folder that holds keys is accepted and the folder stays', () => {
  for (const cache of [false, true]) {
    setGuildViewCache(cache);
    const g = cache ? '9414000002' : '9414000001';
    const p = (rel: string) => dataPath(g, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p('m/A/x.json')), { recursive: true });
    fs.writeFileSync(p('m/A/x.json'), '{}');
    fs.writeFileSync(p('m/a'), '{}');
    expect(placeGuildWrite(g, 'm/a')).toEqual({ ok: true });
    expect(fs.readFileSync(p('m/A/x.json'), 'utf8')).toBe('{}');
  }
});

// The same row on any host: the listings show what a case-sensitive disk holds, 'm/a' a file and 'm/A' a folder.
it('an overwrite beside a listed case alias folder that holds keys is accepted, with no removal tried', () => {
  const real = (fs as any)[REAL_FS] as typeof fs;
  const g = '9414000003';
  const p = (rel = '') => (rel ? dataPath(g, ...rel.split('/')) : dataPath(g));
  fs.mkdirSync(p('m'), { recursive: true });
  fs.writeFileSync(p('m/a'), '{}');
  const entry = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir });
  const m = path.resolve(p('m'));
  const alias = path.resolve(p('m/A'));
  vi.spyOn(fs, 'readdirSync').mockImplementation(((q: any, ...rest: any[]) => {
    const abs = path.resolve(String(q));
    if (abs === alias) return [entry('x.json', false)];
    const out = (real.readdirSync as any)(q, ...rest);
    return abs === m ? [...out, entry('A', true)] : out;
  }) as any);
  const rmdir = vi.spyOn(fs, 'rmdirSync');
  const unlink = vi.spyOn(fs, 'unlinkSync');
  expect(placeGuildWrite(g, 'm/a')).toEqual({ ok: true });
  expect(rmdir).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
});
