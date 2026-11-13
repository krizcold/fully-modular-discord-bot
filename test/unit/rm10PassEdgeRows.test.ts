import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The pass's module step (passModule, sourceFolders) in src/bot/internalSetup/utils/moduleApply.ts on edge inputs:
// a row whose sha is empty, and a machine with no source modules folder, over NB6's apply rig.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

const crashes = vi.hoisted(() => ({ startStateCalls: [] as string[] }));

vi.mock('../../src/bot/internalSetup/utils/moduleCrashes', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    startStateOf: (module: string) => {
      crashes.startStateCalls.push(module);
      return real.startStateOf(module);
    },
  };
});

import fs from 'fs';
import { applyRig } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';

const rig = applyRig();
const X = 'b'.repeat(64);

beforeEach(async () => {
  await rig.setup();
  crashes.startStateCalls = [];
});
afterEach(() => rig.teardown());

const FILE_LIST = 'SELECT rel, mode, octet_length(bytes) AS size FROM smdb_data.shared_module_files';

describe('the pass on a row whose sha is empty', () => {
  it('asks the database for the files of the row, for an entry written under another main with no folder', async () => {
    rig.state.rows.modules.set('m', { sha: '', rev: '1', version: null, file_count: 0, bytes: 0, updated_by: 'BRAVO/p-bravo' } as never);
    const read = readStoreRecord();
    if (!read.ok) throw new Error(read.reason);
    read.record.modules.m = { sha: X, stamp: null, files: {}, main: '0:OLD', built: null, failedSha: null, retryAt: null, heldSha: null, status: null, applying: null };
    writeStoreRecord(read.record);
    const listed: unknown[] = [];
    rig.state.rows.fault = (sql, params) => {
      if (sql.startsWith(FILE_LIST)) listed.push(params?.[0]);
      return undefined;
    };

    expect(await rig.pass()).toBe(true);

    expect(listed).toEqual(['m']);
  });
});

describe('the pass on a machine with no source modules folder', () => {
  it('looks at no module when the database and the store record hold none', async () => {
    fs.rmSync(rig.state.source, { recursive: true, force: true });

    expect(await rig.pass()).toBe(true);

    expect(crashes.startStateCalls).toEqual([]);
    expect(rig.state.lines.filter(l => l.startsWith('[Shared]'))).toEqual([]);
    const read = readStoreRecord();
    expect(read.ok && Object.keys(read.record.modules)).toEqual([]);
  });
});
