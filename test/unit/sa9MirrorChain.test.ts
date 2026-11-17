import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The web UI's pass of the App Store docs writes a row's bytes to its mirror file with a sync of the file's own folder
// only: a failing sync of a folder above it does not make the written mirror a failed write.

const h = vi.hoisted(() => ({ failChainOf: null as string | null, chains: [] as string[] }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      h.chains.push(path.resolve(dir));
      if (h.failChainOf !== null && path.resolve(dir) === h.failChainOf) {
        const error = Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
        return { failed: true, kind: 'sync', dir: path.dirname(h.failChainOf), errno: 'EIO', error };
      }
      return real.syncFolderChainSync(dir);
    },
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runStoreDocsPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { sha, sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const REPOS_KEY = 'global/appstore/repos.json';
const REPOS_FILE = path.join(STORE, 'repos.json');

let rows: ReturnType<typeof sharedRows>;
let lines: string[];
let applied: string[];
let unhook: () => void;

beforeEach(() => {
  lines = [];
  applied = [];
  h.failChainOf = null;
  h.chains.length = 0;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  rows = sharedRows();
  useWebuiSessions({
    target: async () => ({ entry: 'postgres://nobody@127.0.0.1:9/none', tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text, values) => {
      const res = await rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:ALPHA',
  });
  unhook = dm.onSharedApplied('global/appstore/', key => { applied.push(key); });
});

afterEach(() => {
  unhook();
  useWebuiSessions(null);
  _resetRowQueue();
  _resetSharedMirror();
  setMainChooser(null);
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('the mirror write of a stored App Store doc', () => {
  it('lands and is recorded while a sync of the folder chain above it fails', async () => {
    rows.put(REPOS_KEY, 'v1');
    h.failChainOf = path.resolve(STORE);
    expect(await runStoreDocsPass(fn => fn())).toEqual({ ok: true });
    expect(fs.readFileSync(REPOS_FILE, 'utf8')).toBe('v1');
    expect(h.chains).not.toContain(path.resolve(STORE));
    const record = readStoreRecord();
    expect(record.ok && record.record.docs[REPOS_KEY]).toEqual({ sha: sha('v1'), stamp: null, main: '1:ALPHA' });
    expect(applied).toEqual([REPOS_KEY]);
    expect(lines.filter(l => l.startsWith('[Shared] Could not write '))).toEqual([]);
  });
});
