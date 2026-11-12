import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  _resetModuleCrashes,
  applyBootRule,
  applyOfStart,
  applyTails,
  crashFilePath,
  crashLineOf,
  isHeld,
  pruneCrashLines,
  startModule,
  type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { storeRecordPath, type ModuleEntry } from '../../src/bot/internalSetup/utils/sharedRecords';

const COUNT_FAILED = '[Error] The module crash count could not be written';

function entry(over: Partial<ModuleEntry> = {}): ModuleEntry {
  return { sha: 'sha-old', stamp: null, files: {}, main: null, built: null, failedSha: null, retryAt: null, ...over };
}

function writeStore(text: string): void {
  fs.mkdirSync(path.dirname(storeRecordPath()), { recursive: true });
  fs.writeFileSync(storeRecordPath(), text);
}

function writeCrashes(text: string): void {
  fs.mkdirSync(path.dirname(crashFilePath()), { recursive: true });
  fs.writeFileSync(crashFilePath(), text);
}

function start(module: string, sha: string | null, version = '1.0.0'): ModuleStart {
  return { module, sha, version, dir: '/nowhere', boot: false, turnAt: null, late: false };
}

let errors: string[];
let origError: typeof console.error;

beforeEach(() => {
  _resetModuleCrashes();
  errors = [];
  origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
});

afterEach(() => {
  console.error = origError;
  _resetModuleCrashes();
  fs.rmSync(crashFilePath(), { recursive: true, force: true });
  fs.rmSync(storeRecordPath(), { recursive: true, force: true });
});

describe('a crash file that is not an object of lines', () => {
  it('a file holding null reads as no lines, with nothing logged', () => {
    writeCrashes('null');
    expect(crashLineOf('m')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('a file holding a string gives no line for an index into it', () => {
    writeCrashes('"abc"');
    expect(crashLineOf('0')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('a file holding an array gives no line for its elements', () => {
    writeCrashes(JSON.stringify([{ sha: 's', n: 2, version: '1', error: 'e', at: 'now' }]));
    expect(crashLineOf('0')).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe('a crash file that cannot be read', () => {
  beforeEach(() => {
    fs.mkdirSync(crashFilePath(), { recursive: true });
  });

  it('crashLineOf answers null and logs that the count could not be written', () => {
    expect(crashLineOf('m')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`${COUNT_FAILED} (`)).toBe(true);
  });

  it('the boot rule logs that the count could not be written and writes no store record', () => {
    applyBootRule();
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`${COUNT_FAILED} (`)).toBe(true);
    expect(fs.existsSync(storeRecordPath())).toBe(false);
  });

  it('the prune logs that the count could not be written', () => {
    pruneCrashLines(() => []);
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`${COUNT_FAILED} (`)).toBe(true);
  });
});

describe('isHeld with a store record that cannot be read', () => {
  it('answers not held, and a start of the version opens', () => {
    writeStore('not json');
    expect(isHeld('m', 'sha-x')).toBe(false);
    const answer = startModule('m', 'sha-x', '1.0.0', '/nowhere');
    expect(typeof answer).toBe('object');
    expect((answer as ModuleStart).sha).toBe('sha-x');
  });
});

describe('the boot rule with nothing to hold', () => {
  it('leaves an absent store record absent', () => {
    writeCrashes(JSON.stringify({ m: { sha: 'sha-old', n: 1, version: '1', error: 'e', at: 'now' } }));
    applyBootRule();
    expect(fs.existsSync(storeRecordPath())).toBe(false);
    expect(errors).toEqual([]);
  });

  it('leaves the bytes of a store record untouched', () => {
    const text = JSON.stringify({ docs: {}, modules: { m: entry() } });
    writeStore(text);
    writeCrashes(JSON.stringify({ m: { sha: 'sha-old', n: 1, version: '1', error: 'e', at: 'now' } }));
    applyBootRule();
    expect(fs.readFileSync(storeRecordPath(), 'utf8')).toBe(text);
  });
});

describe('pruneCrashLines', () => {
  it('writes no crash file when there is none', () => {
    pruneCrashLines(() => []);
    expect(fs.existsSync(crashFilePath())).toBe(false);
    expect(errors).toEqual([]);
  });

  it('leaves the bytes untouched when every line is kept', () => {
    const text = JSON.stringify({ m: { sha: 'sha-old', n: 1, version: '1', error: 'e', at: 'now' } });
    writeCrashes(text);
    pruneCrashLines(() => ['sha-old']);
    expect(fs.readFileSync(crashFilePath(), 'utf8')).toBe(text);
  });

  it('deletes a null line beside a kept one, with nothing logged', () => {
    const kept = { sha: 'sha-k', n: 1, version: '1', error: 'e', at: 'now' };
    writeCrashes(JSON.stringify({ broken: null, k: kept }));
    pruneCrashLines(module => (module === 'k' ? ['sha-k'] : ['sha-other']));
    expect(errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(crashFilePath(), 'utf8'))).toEqual({ k: kept });
  });
});

describe('applyOfStart and applyTails', () => {
  const applying = (over: Record<string, unknown> = {}) => ({
    from: 'sha-old', to: 'sha-new', backup: null, displaced: 'backups', tag: null, version: '2.0.0', updatedBy: null, ...over,
  });

  it('a start with no sha is no apply, even when the entry is applying to null', () => {
    writeStore(JSON.stringify({ docs: {}, modules: { m: entry({ applying: applying({ to: null }) as any }) } }));
    expect(applyOfStart(start('m', null))).toBeNull();
    expect(applyTails(start('m', null))).toEqual({ t27: '', t29: '' });
  });

  it('a module with no entry is no apply', () => {
    writeStore(JSON.stringify({ docs: {}, modules: {} }));
    expect(applyOfStart(start('gone', 'sha-new'))).toBeNull();
  });

  it('an apply to another sha is not this start\'s apply', () => {
    writeStore(JSON.stringify({ docs: {}, modules: { m: entry({ applying: applying({ to: 'sha-other' }) as any }) } }));
    expect(applyOfStart(start('m', 'sha-new'))).toBeNull();
    expect(applyTails(start('m', 'sha-new'))).toEqual({ t27: '', t29: '' });
  });

  it('the tails name the apply\'s version and the previous version', () => {
    writeStore(JSON.stringify({ docs: {}, modules: { m: entry({ applying: applying() as any }) } }));
    expect(applyOfStart(start('m', 'sha-new', '1.0.0'))).toEqual({ from: 'sha-old', to: 'sha-new', version: '2.0.0' });
    expect(applyTails(start('m', 'sha-new', '1.0.0'))).toEqual({
      t27: '; this machine finishes applying 2.0.0 when they finish without an error, or at 10 minutes; an error makes it keep the previous version',
      t29: ' and keeps 2.0.0',
    });
  });

  it('an install from nothing says no copy of the module is kept', () => {
    writeStore(JSON.stringify({ docs: {}, modules: { m: entry({ applying: applying({ from: 'absent' }) as any }) } }));
    expect(applyTails(start('m', 'sha-new', '1.0.0')).t27).toBe(
      '; this machine finishes applying 2.0.0 when they finish without an error, or at 10 minutes; an error makes it keep no copy of m',
    );
  });
});
