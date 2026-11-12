import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// updateRepository and removeRepository with their awaited forms: their checks of a new URL or branch, the 409 and 202
// answers on a Postgres bot through the real flush over scripted clients (helpers/sharedRows.ts), and a JSON bot's
// answer without the store mutex.

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
import { AppStoreManager, StoreWriteError, storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const REPOS = path.join(STORE, 'repos.json');
const REPOS_KEY = 'global/appstore/repos.json';
const AT = '2026-11-07T10:00:00.000Z';
const LOCK = /pg_advisory_xact_lock/;
const CHANGED_ELSEWHERE = `repos.json was changed on BRAVO at ${AT} while this change was being made; nothing was saved. Reload the App Store tab to see the current values.`;
const NO_ANSWER = "Can't confirm that the repository list change was saved: the database has not answered yet (no answer within 40 s). Reload the App Store tab in a minute to see whether it was.";

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;

beforeEach(() => {
  for (const dir of [STORE, dataPath('appstore-modules'), dataPath('build-modules'), dataPath('runtime-modules'), dataPath('_superseded')]) fs.rmSync(dir, { recursive: true, force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  vi.useRealTimers();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  setBackendKind(null);
  vi.restoreAllMocks();
});

async function landedStore(): Promise<AppStoreManager> {
  const m = new AppStoreManager();
  await dm.flushAll();
  expect(rows.docs.get(REPOS_KEY)?.sha).toBe(sha(fs.readFileSync(REPOS)));
  rig.sent.length = 0;
  return m;
}

function holdAtLock(): { release: () => void } {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  rows.fault = sql => {
    if (!LOCK.test(sql) || !first) return undefined;
    first = false;
    return held.then(() => undefined);
  };
  return { release };
}

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !test(); i++) await new Promise<void>(resolve => { setImmediate(resolve); });
  expect(test()).toBe(true);
}

const reposOnDisk = () => JSON.parse(fs.readFileSync(REPOS, 'utf8')).repositories as Array<{ id: string; name: string; url: string; branch: string }>;

describe('a JSON bot', () => {
  it('updateRepository refuses a branch name that fails the check and leaves repos.json as it was', () => {
    setBackendKind('file');
    const m = new AppStoreManager();
    const before = fs.readFileSync(REPOS, 'utf8');
    expect(() => m.updateRepository('official-modules', { branch: 'bad branch;rm' })).toThrow('Invalid branch name: Branch name contains invalid characters');
    expect(fs.readFileSync(REPOS, 'utf8')).toBe(before);
  });

  it('updateRepositoryAwaited answers without waiting for the store mutex', async () => {
    setBackendKind('file');
    const m = new AppStoreManager();
    const hold = (await storeMutex.acquire())!;
    let settled: unknown = 'pending';
    try {
      void m.updateRepositoryAwaited('official-modules', { name: 'Renamed' }).then(v => { settled = v; }, e => { settled = e; });
      await until(() => settled !== 'pending');
    } finally {
      hold.release();
    }
    expect(settled).toBe(true);
    expect(reposOnDisk()[0].name).toBe('Renamed');
  });

  it('removeRepositoryAwaited answers without waiting for the store mutex', async () => {
    setBackendKind('file');
    const m = new AppStoreManager();
    const hold = (await storeMutex.acquire())!;
    let settled: unknown = 'pending';
    try {
      void m.removeRepositoryAwaited('official-modules').then(v => { settled = v; }, e => { settled = e; });
      await until(() => settled !== 'pending');
    } finally {
      hold.release();
    }
    expect(settled).toBe(true);
    expect(reposOnDisk()).toEqual([]);
  });
});

describe('a Postgres bot: updateRepositoryAwaited', () => {
  it('refuses a URL that fails the check, and nothing is stored', async () => {
    const m = await landedStore();
    const storedBefore = rows.docs.get(REPOS_KEY)!.sha;
    const before = fs.readFileSync(REPOS, 'utf8');
    const error = await m.updateRepositoryAwaited('official-modules', { url: 'http://github.com/someone/modules' }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Invalid repository URL: Repository URL must use HTTPS protocol');
    await dm.flushAll();
    expect(rows.docs.get(REPOS_KEY)!.sha).toBe(storedBefore);
    expect(fs.readFileSync(REPOS, 'utf8')).toBe(before);
  });

  it('answers 409 with the machine and time when repos.json changed on another machine', async () => {
    const m = await landedStore();
    rows.put(REPOS_KEY, JSON.stringify({ repositories: [] }, null, 2), 'BRAVO/p-bravo');
    const error = await m.updateRepositoryAwaited('official-modules', { name: 'Renamed' }).catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(409);
    expect(error.message).toBe(CHANGED_ELSEWHERE);
  });

  it('answers 202 naming the repository list when the database does not answer within 40 s', async () => {
    const m = await landedStore();
    const lock = holdAtLock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = m.updateRepositoryAwaited('official-modules', { name: 'Renamed' }).catch(e => e);
    await vi.advanceTimersByTimeAsync(40_000);
    const error = await answer;
    vi.useRealTimers();
    lock.release();
    await dm.flushAll();
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(202);
    expect(error.message).toBe(NO_ANSWER);
  });
});

describe('a Postgres bot: removeRepositoryAwaited', () => {
  it('answers 409 with the machine and time when repos.json changed on another machine', async () => {
    const m = await landedStore();
    rows.put(REPOS_KEY, JSON.stringify({ repositories: [] }, null, 2), 'BRAVO/p-bravo');
    const error = await m.removeRepositoryAwaited('official-modules').catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(409);
    expect(error.message).toBe(CHANGED_ELSEWHERE);
  });

  it('answers 202 naming the repository list when the database does not answer within 40 s', async () => {
    const m = await landedStore();
    const lock = holdAtLock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = m.removeRepositoryAwaited('official-modules').catch(e => e);
    await vi.advanceTimersByTimeAsync(40_000);
    const error = await answer;
    vi.useRealTimers();
    lock.release();
    await dm.flushAll();
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(202);
    expect(error.message).toBe(NO_ANSWER);
  });
});
