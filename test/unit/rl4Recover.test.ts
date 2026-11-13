import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot's recovery of cut-off applies (NB6 decision 45 (1), 66): what it logs when the store record cannot be read,
// when the store lock throws, and which modules it then leaves out at this start.

const lockFault = vi.hoisted(() => ({ throwNext: false }));

vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    withStoreLock: (fn: () => unknown) => {
      if (lockFault.throwNext) {
        lockFault.throwNext = false;
        throw new Error('the store lock is held');
      }
      return real.withStoreLock(fn);
    },
  };
});

import fs from 'fs';
import path from 'path';
import { dataPath } from '../../src/utils/dataRoot';
import { recoverModuleApplies } from '../../src/bot/internalSetup/utils/moduleApply';
import { _resetModuleCrashes, onModuleCode } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { storeRecordPath, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { clearLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  lockFault.throwNext = false;
  _resetModuleCrashes();
  clearLoadFailures();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
});

afterEach(() => {
  lockFault.throwNext = false;
  _resetModuleCrashes();
  clearLoadFailures();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const entry = (applying: unknown) => ({
  sha: 'absent', stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: null, retryAt: null, heldSha: null, status: null, applying,
});

const intent = (to: string) => ({ from: 'absent', to, backup: null, displaced: 'backups', tag: '1:ALPHA', version: '1.0.0', updatedBy: 'BRAVO/p-bravo' });

const skipped = (module: string) => onModuleCode({ name: module, path: path.join(dataPath('x'), module), version: '1.0.0' }) === 'skip';

function writeRaw(text: string): void {
  fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
  fs.writeFileSync(storeRecordPath(), text);
}

describe('recoverModuleApplies', () => {
  it('a store record that is not JSON is logged with its reason, and nothing else is touched', () => {
    writeRaw('{not json');
    recoverModuleApplies();
    expect(lines).toEqual([`[Shared] Did not recover the module applies: ${storeRecordPath()} is not JSON`]);
    expect(fs.readFileSync(storeRecordPath(), 'utf8')).toBe('{not json');
  });

  it('an entry with no apply is left as it is and nothing is logged', () => {
    writeStoreRecord({ docs: {}, modules: { m: entry(null) } } as any);
    const before = fs.readFileSync(storeRecordPath(), 'utf8');
    recoverModuleApplies();
    expect(lines).toEqual([]);
    expect(fs.readFileSync(storeRecordPath(), 'utf8')).toBe(before);
    expect(skipped('m')).toBe(false);
  });

  it('a null module entry is passed over without an error', () => {
    writeStoreRecord({ docs: {}, modules: { m: null } } as any);
    expect(() => recoverModuleApplies()).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('when the store lock throws, the unfinished modules are named in name order and left out at this start', () => {
    writeStoreRecord({ docs: {}, modules: { b: entry(intent('sb')), done: entry(null), a: entry(intent('sa')) } } as any);
    lockFault.throwNext = true;
    recoverModuleApplies();
    expect(lines).toEqual([
      '[Shared] Did not recover the module applies: the store lock is held; the modules with an unfinished update (a, b) are not loaded at this start',
    ]);
    expect(skipped('a')).toBe(true);
    expect(skipped('b')).toBe(true);
    expect(skipped('done')).toBe(false);
  });

  it('when the store lock throws, a null entry beside an unfinished one does not stop the log', () => {
    writeStoreRecord({ docs: {}, modules: { n: null, a: entry(intent('sa')) } } as any);
    lockFault.throwNext = true;
    expect(() => recoverModuleApplies()).not.toThrow();
    expect(lines).toEqual([
      '[Shared] Did not recover the module applies: the store lock is held; the modules with an unfinished update (a) are not loaded at this start',
    ]);
  });

  it('when the store lock throws and the record cannot be read, no module is named', () => {
    writeRaw('{not json');
    lockFault.throwNext = true;
    recoverModuleApplies();
    expect(lines).toEqual(['[Shared] Did not recover the module applies: the store lock is held']);
  });
});
