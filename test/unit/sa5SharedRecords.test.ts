import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// folderChain reads the platform once at load: it loads here as on Linux, where production runs and folders are synced.
const platform = vi.hoisted(() => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  return real;
});

import { noteFolderSyncFailure } from '../../src/bot/internalSetup/utils/folderChain';
import {
  docRecordPath,
  readDocRecord,
  readStoreRecord,
  storeRecordPath,
  writeDocRecord,
  writeStoreRecord,
} from '../../src/bot/internalSetup/utils/sharedRecords';

afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
});

const entry = { sha: 'a1', stamp: null, main: '3:node-a' };

describe('sa5: the mirror records are written after a folder sync of this process failed', () => {
  it('writes the doc record whole and does not throw', () => {
    noteFolderSyncFailure(path.dirname(docRecordPath()), 'EIO');
    const record = { docs: { 'guide.md': entry } };
    expect(() => writeDocRecord(record)).not.toThrow();
    expect(fs.readFileSync(docRecordPath(), 'utf8')).toBe(JSON.stringify(record, null, 2));
    expect(readDocRecord()).toEqual({ ok: true, record });
  });

  it('writes the store record whole and does not throw', () => {
    noteFolderSyncFailure(path.dirname(storeRecordPath()), 'EIO');
    const record = { docs: { 'readme.md': entry }, modules: {}, statusSeq: 2 };
    expect(() => writeStoreRecord(record)).not.toThrow();
    expect(fs.readFileSync(storeRecordPath(), 'utf8')).toBe(JSON.stringify(record, null, 2));
    expect(readStoreRecord()).toEqual({ ok: true, record });
  });
});
