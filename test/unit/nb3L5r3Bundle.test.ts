import fs from 'fs';
import path from 'path';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { setBackendKind } from '../helpers/backendKind';
import { MARKER, PG_URL, freshJsonBot, root, seedFile, useDatabaseUrl } from '../helpers/migrationRig';

// NB3: a bundle import compares the marker and the journal before and after staging; a read that throws a value
// with no code counts as "[unreadable]".

const G = '151515151515151517';

let restore: (() => void) | null = null;
let file = '';

function stubMarkerRead(impl: () => string): void {
  const real = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(MARKER)) return impl();
    return (real as any)(p, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  restore = () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
}

beforeEach(async () => {
  freshJsonBot();
  setBackendKind('file');
  useDatabaseUrl(PG_URL);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  seedFile(`${G}/mod/a.json`, '{"a":"bundled"}');
  file = path.join(root, '..', `nb3-r3-bundle-${process.pid}-${Date.now()}.dbex`);
  await writeBundle(G, file);
  fs.writeFileSync(path.join(root, G, 'mod', 'a.json'), '{"a":"live"}');
});
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
  fs.rmSync(file, { force: true });
});

describe('importBundle with a marker read that throws a value with no code', () => {
  it('goes ahead when every marker read throws undefined', async () => {
    stubMarkerRead(() => { throw undefined; });
    const result = await importBundle(file);
    expect(result.guildId).toBe(G);
    expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf-8')).toBe('{"a":"bundled"}');
  });

  it('refuses when the marker read "[]" at the check and then throws a codeless Error', async () => {
    let staged = false;
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes('.bundle-import-') && rest[0] === 'w') staged = true;
      return (realOpen as any)(p, ...rest);
    }) as any);
    stubMarkerRead(() => {
      if (staged) throw new Error('no code');
      return '[]';
    });
    await expect(importBundle(file)).rejects.toThrow(/changed while the import ran, so a data migration may have started/);
    expect(staged).toBe(true);
    expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf-8')).toBe('{"a":"live"}');
    expect(fs.existsSync(path.join(root, '_graveyard'))).toBe(false);
  });
});
