import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 fix of part 26, D1 (wip-redesign/sheets/NB6.md decision 31, sheet 1020-1028: the bot process applies App Store
// docs, its pass and its listener, under the store lock and the store mutex): on a Postgres bot whose child runs,
// another machine's App Store doc change reaches this machine's mirror and the store record through the bot's full
// pass and through its listener, and the next save on this machine builds on it. Rows are written by
// helpers/sharedRows.ts as the flush stores them; the first version is the real manager's, landed by the real flush.

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    throw new Error(`unexpected command in test: ${cmd.split(' ').slice(0, 2).join(' ')}`);
  };
  return { ...real, execSync, default: { ...real, execSync } };
});

vi.mock('../../src/utils/autoSnapshot', () => ({ takeAutoSnapshot: () => undefined }));

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => {
  const real = await orig<any>();
  const root = process.env.DATA_DIR as string;
  return {
    ...real,
    getModulesDir: () => path.join(root, 'runtime-modules'),
    getSourceModulesDir: () => path.join(root, 'appstore-modules'),
    getBuildModulesDir: () => path.join(root, 'build-modules'),
    getModulesDevDir: () => path.join(root, 'modulesDev'),
  };
});

import fs from 'fs';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { AppStoreManager, storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, runSharedPass, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { readStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { setBackendKind } from '../helpers/backendKind';
import { listenRig } from '../helpers/nb6Listen';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const REPOS = path.join(STORE, 'repos.json');
const CREDS = path.join(STORE, 'credentials', 'mod.json');
const REPOS_KEY = 'global/appstore/repos.json';
const CREDS_KEY = 'global/appstore/credentials/mod.json';
const theirs = (...ids: string[]) => JSON.stringify({ repositories: ids.map(id => ({ id, name: id, url: `https://github.com/example/${id}`, branch: 'main', enabled: true })) }, null, 2);

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;

beforeEach(() => {
  for (const dir of [dataPath('global'), dataPath('appstore-modules'), dataPath('_superseded')]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  setMainChooser(null);
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  _setListenClientFactory(null);
  _resetSharedMirror();
  vi.useRealTimers();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  setBackendKind(null);
  vi.restoreAllMocks();
});

/** A manager whose repos.json the real flush stored: the defaults its load queued, landed by the flush's own block. */
async function landedStore(): Promise<AppStoreManager> {
  const m = new AppStoreManager();
  await dm.flushAll();
  expect(rows.docs.get(REPOS_KEY)?.sha).toBe(sha(fs.readFileSync(REPOS)));
  rig.sent.length = 0;
  return m;
}

const storeEntry = (key: string) => {
  const record = readStoreRecord();
  if (!record.ok) throw new Error(record.reason);
  return record.record.docs[key];
};

/** Another machine's version of repos.json and of a module's credentials, stored after this machine's. */
function changedElsewhere(): void {
  rows.put(REPOS_KEY, theirs('their-repo'));
  rows.put(CREDS_KEY, JSON.stringify({ token: 'made-up' }, null, 2));
}

function expectMirrored(): void {
  expect(fs.readFileSync(REPOS).equals(rows.docs.get(REPOS_KEY)!.body)).toBe(true);
  expect(storeEntry(REPOS_KEY)).toEqual({ sha: rows.docs.get(REPOS_KEY)!.sha, stamp: null, main: null });
}

describe("D1: the bot's full pass applies App Store docs", () => {
  it("another machine's repos.json and a module's credentials reach the mirror and the store record; a save after it is stored", async () => {
    const m = await landedStore();
    changedElsewhere();
    const res = await runSharedPass({ rehash: true });
    expect(res).toEqual({ answered: true, cause: null });
    expectMirrored();
    expect(fs.readFileSync(CREDS).equals(rows.docs.get(CREDS_KEY)!.body)).toBe(true);
    expect(storeEntry(CREDS_KEY)).toEqual({ sha: rows.docs.get(CREDS_KEY)!.sha, stamp: null, main: null });
    const repo = await m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main');
    const stored = JSON.parse(rows.docs.get(REPOS_KEY)!.body.toString('utf8')).repositories.map((r: { id: string }) => r.id);
    expect(stored).toEqual(['their-repo', repo.id]);
  });

  it('the pass holds the store mutex for the App Store keys and gives it back', async () => {
    await landedStore();
    changedElsewhere();
    const acquire = vi.spyOn(storeMutex, 'acquire');
    await runSharedPass({ rehash: true });
    expect(acquire).toHaveBeenCalledTimes(1);
    const hold = await storeMutex.acquire(10);
    expect(hold).not.toBeNull();
    hold!.release();
  });

  it('a key with an open op of this process is left to the op; the other keys are applied', async () => {
    await landedStore();
    changedElsewhere();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    rows.fault = sql => {
      if (!/pg_advisory_xact_lock/.test(sql) || !first) return undefined;
      first = false;
      return held.then(() => undefined);
    };
    dm.writeRawAtomicTracked(CREDS, '{"token":"mine"}', { baseSha: 'absent' });
    await vi.waitFor(() => expect(first).toBe(false));
    await runSharedPass({ rehash: true });
    expectMirrored();
    expect(fs.existsSync(CREDS)).toBe(false);
    expect(storeEntry(CREDS_KEY)).toBeUndefined();
    expect(rowQueue.ops(CREDS_KEY)).toHaveLength(1);
    release();
  });
});

describe("D1: the bot's listener applies an App Store doc", () => {
  it("a notice of another machine's change brings the mirror up; a save after it is stored", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const m = await landedStore();
    const listen = listenRig();
    _setListenClientFactory(listen.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(listen.last()?.queries).toContain('LISTEN smdb_guild_requests'));
    await runSharedPass();
    rows.put(REPOS_KEY, theirs('their-repo'));
    listen.last().notify('smdb_shared', JSON.stringify({ k: 'doc', key: REPOS_KEY, sha: rows.docs.get(REPOS_KEY)!.sha, rev: 9, by: '00000000-0000-4000-8000-000000000001' }));
    await vi.waitFor(() => expectMirrored());
    const repo = await m.addRepositoryAwaited('Extra', 'https://github.com/example/extra', 'main');
    const stored = JSON.parse(rows.docs.get(REPOS_KEY)!.body.toString('utf8')).repositories.map((r: { id: string }) => r.id);
    expect(stored).toEqual(['their-repo', repo.id]);
  });
});
