import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rg2: repos.json and the credentials docs as shared keys on a Postgres bot (decision 28), through the
// real AppStoreManager over scripted clients that answer as the shared tables do (helpers/sharedRows.ts).

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
import { AppStoreManager, isSharedStoreDoc } from '../../src/bot/internalSetup/utils/appStoreManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

const STORE = dataPath('global', 'appstore');
const REPOS = path.join(STORE, 'repos.json');

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
  dm.setSharedWriteGate(null);
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  vi.restoreAllMocks();
});

async function landedStore(): Promise<AppStoreManager> {
  const m = new AppStoreManager();
  await dm.flushAll();
  return m;
}

describe('an added repository whose shared write is refused at the accept', () => {
  it('is not listed afterwards: the list is read back from repos.json', async () => {
    const m = await landedStore();
    expect(isSharedStoreDoc(REPOS)).toBe(true);
    const before = fs.readFileSync(REPOS);
    const names = m.getRepositories().map(r => r.name);
    expect(names).not.toContain('New');
    dm.setSharedWriteGate(() => false);
    const error = await m.addRepositoryAwaited('New', 'https://github.com/example/new', 'main').then(() => null, e => e);
    dm.setSharedWriteGate(null);
    expect(error?.message).toBe('The repository list could not be saved, so the repository was not added.');
    expect(m.getRepositories().map(r => r.name)).toEqual(names);
    expect(fs.readFileSync(REPOS).equals(before)).toBe(true);
  });
});

describe('deleting credentials a module does not have', () => {
  it('answers true and queues nothing', async () => {
    const m = await landedStore();
    const file = path.join(STORE, 'credentials', 'nobody.json');
    expect(isSharedStoreDoc(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    rig.sent.length = 0;
    await expect(m.deleteCredentialsAwaited('nobody')).resolves.toBe(true);
    expect(m.deleteCredentials('nobody')).toBe(true);
    expect(rows.docs.has('global/appstore/credentials/nobody.json')).toBe(false);
  });
});
