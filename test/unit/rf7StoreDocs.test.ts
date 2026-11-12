import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async orig => {
  const real = await orig<any>();
  const execSync = (cmd: string) => {
    if (cmd.startsWith('git rev-parse HEAD')) return Buffer.from('a'.repeat(40));
    if (cmd.startsWith('git remote set-url') || cmd.startsWith('git fetch')) return Buffer.from('');
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
import { AppStoreManager, StoreWriteError, awaitStoreDoc, queueStoreDoc, withStoreLock } from '../../src/bot/internalSetup/utils/appStoreManager';
import { appStoreConfigPath, componentConfigPath, writeConfigFile } from '../../src/bot/internalSetup/utils/appStoreConfigFile';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const LOCK = /pg_advisory_xact_lock/;

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
  dm.setSharedWriteGate(null);
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

async function landedStore(): Promise<void> {
  new AppStoreManager();
  await dm.flushAll();
  rig.sent.length = 0;
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

async function unanswered(file: string): Promise<StoreWriteError> {
  await landedStore();
  const lock = holdAtLock();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const answer = writeConfigFile(file, { autoUpdate: true }).then(() => null, e => e);
  await vi.advanceTimersByTimeAsync(40_000);
  const error = await answer;
  vi.useRealTimers();
  lock.release();
  await dm.flushAll();
  return error;
}

describe('a config file write the database has not answered within 40 s names its change', () => {
  it('the command settings file answers 202 naming the command settings', async () => {
    const error = await unanswered(componentConfigPath());
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(202);
    expect(error.message).toBe("Can't confirm that the command settings change was saved: the database has not answered yet (no answer within 40 s). Reload the App Store tab in a minute to see whether it was.");
  });

  it('the App Store settings file answers 202 naming the App Store settings', async () => {
    const error = await unanswered(appStoreConfigPath());
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(202);
    expect(error.message).toBe("Can't confirm that the App Store settings change was saved: the database has not answered yet (no answer within 40 s). Reload the App Store tab in a minute to see whether it was.");
  });
});

describe('queueStoreDoc deletes', () => {
  it('a delete of a doc that is not there queues nothing and answers null', async () => {
    await landedStore();
    const file = appStoreConfigPath();
    expect(fs.existsSync(file)).toBe(false);
    expect(withStoreLock(() => queueStoreDoc(file, null, 'absent'))).toBeNull();
  });

  it('a delete refused at the accept answers the refusal with its cause', async () => {
    await landedStore();
    const file = appStoreConfigPath();
    await writeConfigFile(file, { autoUpdate: true });
    dm.setSharedWriteGate(() => false);
    expect(withStoreLock(() => queueStoreDoc(file, null, sha(fs.readFileSync(file))))).toEqual({ file, refused: 'not-ready' });
    dm.setSharedWriteGate(null);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('a delete built on bytes that are no longer stored is refused and the doc is kept', async () => {
    await landedStore();
    const file = appStoreConfigPath();
    await writeConfigFile(file, { autoUpdate: true });
    const stale = sha(JSON.stringify({ autoUpdate: false }, null, 2));
    const queued = withStoreLock(() => queueStoreDoc(file, null, stale));
    expect(queued).not.toBeNull();
    const error = await awaitStoreDoc(queued!, 'App Store settings').then(() => null, e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.status).toBe(409);
    expect(fs.existsSync(file)).toBe(true);
    expect(rows.docs.has('global/appstore/config.json')).toBe(true);
  });
});
