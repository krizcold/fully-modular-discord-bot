import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The web UI's App Store docs pass (NB6 decision 31) walks /data/global/appstore for doc files; its cache folder is
// this machine's own, so the walk never lists it.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runStoreDocsPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';

const LIST_SQL = 'SELECT key, sha FROM smdb_data.shared_docs';
const STORE = dataPath('global', 'appstore');
const CACHE = path.join(STORE, 'cache');

let listed: string[];

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  useWebuiSessions({
    target: () => new Promise(() => undefined),
    commitCheck: () => null,
    select: async text => {
      if (text === LIST_SQL) return { rows: [] };
      throw new Error(`unexpected statement: ${text}`);
    },
    tag: () => '1:ALPHA',
  });
  listed = [];
  const real = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    listed.push(path.resolve(String(p)));
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readdirSync);
});

afterEach(() => {
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setMainChooser(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('the walk of /data/global/appstore', () => {
  it('lists the folders of store docs and never lists the cache folder or a folder inside it (rd4-3)', async () => {
    const cached = path.join(CACHE, 'sub', 'f.json');
    write(cached, 'cached bytes');
    write(path.join(STORE, 'docs', 'd.json'), 'doc bytes');
    expect(await runStoreDocsPass(fn => fn())).toEqual({ ok: true });
    const cacheRoot = path.resolve(CACHE);
    expect(listed).toContain(path.resolve(STORE));
    expect(listed).toContain(path.resolve(STORE, 'docs'));
    expect(listed.filter(p => p === cacheRoot || p.startsWith(cacheRoot + path.sep))).toEqual([]);
    expect(fs.readFileSync(cached, 'utf8')).toBe('cached bytes');
  });
});
