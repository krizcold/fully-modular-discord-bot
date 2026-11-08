import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, fixer 5 (out/NB6/part-rulings.md "Code review round 1"): findings E6 and E7, App Store doc
// writes on a Postgres bot through the real AppStoreManager, the real facade and the real flush over scripted clients
// that answer as the shared tables do (helpers/sharedRows.ts).

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
import { AppStoreManager, StoreWriteError } from '../../src/bot/internalSetup/utils/appStoreManager';
import { appStoreConfigPath, writeConfigFile } from '../../src/bot/internalSetup/utils/appStoreConfigFile';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const REPOS = path.join(STORE, 'repos.json');
const CREDS = path.join(STORE, 'credentials', 'mod.json');
const CREDS_KEY = 'global/appstore/credentials/mod.json';

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
  dm.setSharedWriteGate(null);
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

async function landedStore(): Promise<AppStoreManager> {
  const m = new AppStoreManager();
  await dm.flushAll();
  rig.sent.length = 0;
  return m;
}

/** The error a read of path gives, as the answer words it. */
function readError(file: string): string {
  try {
    fs.readFileSync(file);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${file} could be read`);
}

const docWrites = () => rig.sent.filter(s => /INSERT INTO smdb_data\.shared_docs|DELETE FROM smdb_data\.shared_docs/.test(s.sql));

describe('E6: a store doc that exists but cannot be read', () => {
  it('a credentials save is refused before anything is queued, with the read error', async () => {
    const m = await landedStore();
    fs.mkdirSync(CREDS, { recursive: true });
    const error = await m.saveCredentialsAwaited('mod', { token: 'x' }).catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.message).toBe(`credentials/mod.json could not be read (${readError(CREDS)}), so nothing was saved.`);
    await dm.flushAll();
    expect(docWrites()).toEqual([]);
    expect(rows.docs.has(CREDS_KEY)).toBe(false);
  });

  it('a credentials delete is refused the same way', async () => {
    const m = await landedStore();
    fs.mkdirSync(CREDS, { recursive: true });
    const error = await m.deleteCredentialsAwaited('mod').catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.message).toBe(`credentials/mod.json could not be read (${readError(CREDS)}), so nothing was saved.`);
    await dm.flushAll();
    expect(docWrites()).toEqual([]);
  });

  it('a config file write with no base is refused the same way', async () => {
    await landedStore();
    fs.mkdirSync(appStoreConfigPath(), { recursive: true });
    const error = await writeConfigFile(appStoreConfigPath(), { autoUpdate: true }).catch(e => e);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect(error.message).toBe(`config.json could not be read (${readError(appStoreConfigPath())}), so nothing was saved.`);
    await dm.flushAll();
    expect(docWrites()).toEqual([]);
  });
});

describe("E7: a store write no reply waits for, refused at the accept", () => {
  it("logs the cause's words as T16 gives them: the cause's name for any cause but changed-elsewhere", async () => {
    const m = await landedStore();
    dm.setSharedWriteGate(() => false);
    expect(() => m.addRepository('Extra', 'https://github.com/example/extra', 'main')).toThrow('The repository list could not be saved, so the repository was not added.');
    expect(errors).toContain('[AppStoreManager] repos.json was not saved: not-ready');
    expect(fs.existsSync(REPOS)).toBe(true);
  });
});
