import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rg5: module credentials on a JSON bot and a Postgres bot (NB6 decision 28) through the real
// AppStoreManager, the real facade and the real flush over scripted clients (helpers/sharedRows.ts); and
// updateAllModules' failed list.

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
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const CREDS_DIR = path.join(STORE, 'credentials');
const CREDS = path.join(CREDS_DIR, 'mod.json');
const CREDS_KEY = 'global/appstore/credentials/mod.json';
const OUTSIDE_NAME = '../cache/mod';
const OUTSIDE = path.join(STORE, 'cache', 'mod.json');
const LOCK = /pg_advisory_xact_lock/;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let errors: string[];

beforeEach(() => {
  errors = [];
  for (const dir of [STORE, dataPath('appstore-modules'), dataPath('build-modules'), dataPath('runtime-modules'), dataPath('_superseded')]) fs.rmSync(dir, { recursive: true, force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  _resetRowQueue();
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  vi.useRealTimers();
  await dm.flushAll().catch(() => undefined);
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  setBackendKind(null);
  await rig.backend.stop();
  vi.restoreAllMocks();
});

async function landedStore(): Promise<AppStoreManager> {
  const m = new AppStoreManager();
  await dm.flushAll();
  rig.sent.length = 0;
  return m;
}

function jsonBot(): AppStoreManager {
  setBackendKind('file');
  return new AppStoreManager();
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

/** Runs call while another App Store section holds the store mutex; the answer must come without the mutex. */
async function answersWhileMutexHeld<T>(call: () => Promise<T>): Promise<T> {
  const hold = (await storeMutex.acquire())!;
  let settled = false;
  const answer = call().finally(() => { settled = true; });
  try {
    for (let i = 0; i < 50 && !settled; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(settled).toBe(true);
  } finally {
    hold.release();
  }
  return answer;
}

describe('a JSON bot writes credentials as files at once, without the store mutex', () => {
  it('saveCredentials writes the file before it returns', () => {
    const m = jsonBot();
    expect(m.saveCredentials('mod', { token: 'x' })).toBe(true);
    expect(fs.readFileSync(CREDS, 'utf8')).toBe(JSON.stringify({ token: 'x' }, null, 2));
  });

  it('saveCredentialsAwaited answers true while another App Store change holds the mutex, and the file holds the credentials', async () => {
    const m = jsonBot();
    await expect(answersWhileMutexHeld(() => m.saveCredentialsAwaited('mod', { token: 'y' }))).resolves.toBe(true);
    expect(fs.readFileSync(CREDS, 'utf8')).toBe(JSON.stringify({ token: 'y' }, null, 2));
  });

  it('deleteCredentialsAwaited answers true while another App Store change holds the mutex, and the file is gone', async () => {
    const m = jsonBot();
    m.saveCredentials('mod', { token: 'x' });
    await expect(answersWhileMutexHeld(() => m.deleteCredentialsAwaited('mod'))).resolves.toBe(true);
    expect(fs.existsSync(CREDS)).toBe(false);
  });

  it('a save that cannot write answers false and logs the failure', () => {
    const m = jsonBot();
    fs.mkdirSync(CREDS, { recursive: true });
    expect(m.saveCredentials('mod', { token: 'x' })).toBe(false);
    expect(errors.some(e => e.startsWith('[AppStoreManager] Failed to save credentials for mod:'))).toBe(true);
  });

  it('a delete that cannot remove the file answers false and logs the failure', () => {
    const m = jsonBot();
    fs.mkdirSync(CREDS, { recursive: true });
    expect(m.deleteCredentials('mod')).toBe(false);
    expect(errors.some(e => e.startsWith('[AppStoreManager] Failed to delete credentials for mod:'))).toBe(true);
    expect(fs.existsSync(CREDS)).toBe(true);
  });
});

describe('a Postgres bot: a credentials path that is no shared key is written as a file, without the store mutex', () => {
  it('saveCredentialsAwaited with a name that resolves into the local cache', async () => {
    const m = await landedStore();
    await expect(answersWhileMutexHeld(() => m.saveCredentialsAwaited(OUTSIDE_NAME, { token: 'x' }))).resolves.toBe(true);
    expect(fs.readFileSync(OUTSIDE, 'utf8')).toBe(JSON.stringify({ token: 'x' }, null, 2));
  });

  it('deleteCredentialsAwaited with a name that resolves into the local cache', async () => {
    const m = await landedStore();
    fs.mkdirSync(path.dirname(OUTSIDE), { recursive: true });
    fs.writeFileSync(OUTSIDE, '{}');
    await expect(answersWhileMutexHeld(() => m.deleteCredentialsAwaited(OUTSIDE_NAME))).resolves.toBe(true);
    expect(fs.existsSync(OUTSIDE)).toBe(false);
  });
});

describe("a Postgres bot: no settle within 40 s answers 202 naming the module's credentials", () => {
  const text = "Can't confirm that the credentials of mod change was saved: the database has not answered yet (no answer within 40 s). Reload the App Store tab in a minute to see whether it was.";

  it('saveCredentialsAwaited', async () => {
    const m = await landedStore();
    const lock = holdAtLock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = m.saveCredentialsAwaited('mod', { token: 'x' }).catch(e => e);
    await vi.advanceTimersByTimeAsync(40_000);
    const error = await answer;
    vi.useRealTimers();
    lock.release();
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error).toMatchObject({ status: 202, message: text });
    await until(() => rowQueue.ops(CREDS_KEY).length === 0);
  });

  it('deleteCredentialsAwaited', async () => {
    const m = await landedStore();
    await expect(m.saveCredentialsAwaited('mod', { token: 'x' })).resolves.toBe(true);
    const lock = holdAtLock();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = m.deleteCredentialsAwaited('mod').catch(e => e);
    await vi.advanceTimersByTimeAsync(40_000);
    const error = await answer;
    vi.useRealTimers();
    lock.release();
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error).toMatchObject({ status: 202, message: text });
    await until(() => rowQueue.ops(CREDS_KEY).length === 0);
  });
});

describe('updateAllModules', () => {
  it('a failed update without an error text is listed with "Unknown error"', async () => {
    const m = jsonBot();
    vi.spyOn(m, 'checkAllModulesForUpdates').mockResolvedValue({ updates: [{ moduleName: 'mod', installedVersion: '1.0.0', hasUpdate: true }], errors: [] } as any);
    vi.spyOn(m, 'updateModule').mockResolvedValue({ success: false });
    const result = await m.updateAllModules();
    expect(result.success).toBe(false);
    expect(result.failed).toEqual([{ moduleName: 'mod', error: 'Unknown error' }]);
  });
});
