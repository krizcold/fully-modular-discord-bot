import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importBundle, writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { cleanOrphanTmpFiles } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { atomicWriteFileSync } from '../../src/bot/internalSetup/utils/atomicWrite';
import { setBackendKind } from '../helpers/backendKind';
import { JOURNAL, PG_URL, freshJsonBot, root, seedFile, useDatabaseUrl } from '../helpers/migrationRig';

// NB3 on a JSON data root: a bundle import beside a journal that turned unreadable, the operator read's key check,
// the orphan temp sweep around a migration's folders, and the mode a strict write keeps.

const G = '151515151515151516';

beforeEach(() => {
  freshJsonBot();
  setBackendKind('file');
  useDatabaseUrl(PG_URL);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('importBundle', () => {
  it('refuses when the journal went from absent to unreadable while the import ran', async () => {
    seedFile(`${G}/mod/a.json`, '{"a":1}');
    const file = path.join(root, '..', `nb3-s15-bundle-${process.pid}-${Date.now()}.dbex`);
    await writeBundle(G, file);
    fs.writeFileSync(path.join(root, G, 'mod', 'a.json'), '{"a":"live"}');
    const real = fs.promises.writeFile;
    let once = false;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (!once && String(p).includes('.bundle-import-')) {
        once = true;
        fs.mkdirSync(JOURNAL);
      }
      return (real as any)(p, ...rest);
    }) as any);
    try {
      await expect(importBundle(file)).rejects.toThrow(/changed while the import ran, so a data migration may have started/);
      expect(once).toBe(true);
      expect(fs.readFileSync(path.join(root, G, 'mod', 'a.json'), 'utf-8')).toBe('{"a":"live"}');
    } finally {
      fs.rmSync(JOURNAL, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
  });
});

describe('the operator read refuses a key that is not canonical', () => {
  it('a module "." and a filename ending in "/" answer invalid', async () => {
    seedFile('123/mod/a.json', '{"a":1}');
    expect(await applyOperatorDataRead({ guildId: '123', module: '.', filename: 'a.json' }))
      .toEqual({ ok: false, code: 'invalid', error: 'invalid module' });
    expect(await applyOperatorDataRead({ guildId: '123', module: 'mod', filename: 'sub/' }))
      .toEqual({ ok: false, code: 'invalid', error: 'invalid filename' });
    expect(await applyOperatorDataRead({ guildId: '123', module: 'mod', filename: './' }))
      .toEqual({ ok: false, code: 'invalid', error: 'invalid filename' });
    const ok = await applyOperatorDataRead({ guildId: '123', module: 'mod', filename: 'a.json' });
    expect(ok).toMatchObject({ ok: true, contentJson: '{"a":1}' });
  });
});

describe('cleanOrphanTmpFiles', () => {
  it('keeps the root\'s _superseded and .migrate- folders and sweeps folders of those names deeper down', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const files = {
      rootSuperseded: path.join(root, '_superseded', 'a.json.1.1.tmp'),
      rootStaging: path.join(root, '.migrate-job-s15', 'b.json.1.1.tmp'),
      guildSuperseded: path.join(root, G, '_superseded', 'c.json.1.1.tmp'),
      guildStaging: path.join(root, G, '.migrate-x', 'd.json.1.1.tmp'),
      guildPlain: path.join(root, G, 'mod', 'e.json.1.1.tmp'),
    };
    for (const f of Object.values(files)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, old, old);
    }
    await cleanOrphanTmpFiles();
    expect(Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.existsSync(f)]))).toEqual({
      rootSuperseded: true,
      rootStaging: true,
      guildSuperseded: false,
      guildStaging: false,
      guildPlain: false,
    });
  });
});

describe('atomicWriteFileSync with keep', () => {
  it.skipIf(process.platform === 'win32')('gives the new file the kept mode whatever the umask', () => {
    const file = path.join(root, 'kept.json');
    const before = process.umask(0o077);
    try {
      atomicWriteFileSync(file, '{}', { mode: 0o100644, uid: process.getuid!(), gid: process.getgid!() });
    } finally {
      process.umask(before);
    }
    expect(fs.statSync(file).mode & 0o7777).toBe(0o644);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{}');
  });
});
