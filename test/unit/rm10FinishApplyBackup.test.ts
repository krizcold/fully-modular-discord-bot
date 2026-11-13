import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// finishApply's backup step in src/bot/internalSetup/utils/moduleApply.ts, over NB6's apply rig.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { finishApply, folderSha } from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
const TO = 'a'.repeat(64);

beforeEach(() => rig.setup());
afterEach(() => rig.teardown());

describe('finishApply after an apply whose live folder was a stray', () => {
  it('finishes without reading the backup, and keeps it, when the backup holds a file that cannot be read', async () => {
    const backup = path.join(rig.state.backups, `m-${Date.now()}`);
    rig.writeTree(backup, { 'module.json': '{"name":"m","version":"0.1.0"}' });
    fs.symlinkSync(path.join(rig.state.root, 'gone'), path.join(backup, 'broken'), 'junction');
    expect(() => folderSha(backup)).toThrow();
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = {
      sha: 'absent', stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: null, retryAt: null, heldSha: null, status: null,
      applying: { from: 'absent', to: TO, backup, displaced: 'superseded', tag: '1:ALPHA', version: '1.0.0', updatedBy: 'BRAVO/p-bravo' },
    };
    writeStoreRecord(read.record);

    await expect(finishApply('m')).resolves.toBeUndefined();

    expect(rig.entry('m')).toMatchObject({ sha: TO, main: '1:ALPHA', applying: null, failedSha: null });
    expect(fs.existsSync(path.join(backup, 'module.json'))).toBe(true);
  });
});
