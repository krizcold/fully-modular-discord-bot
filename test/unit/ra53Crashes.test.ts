import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  _resetModuleCrashes,
  applyTails,
  bootStartOf,
  crashFilePath,
  endStart,
  frameUnder,
  handToBootTurn,
  keptEnds,
  onModuleCode,
  onStartEnded,
  startEnds,
  startFailureOf,
  startModule,
  type ModuleStart,
} from '../../src/bot/internalSetup/utils/moduleCrashes';
import { clearLoadFailures, getLoadFailures } from '../../src/bot/internalSetup/utils/loadFailures';
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

function opened(module: string, sha: string | null): ModuleStart {
  const answer = startModule(module, sha, '1.0.0', '/nowhere');
  if (typeof answer === 'string') throw new Error(`start of ${module} answered ${answer}`);
  return answer;
}

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const stackOf = (...frames: string[]) => ({ stack: ['Error: boom', ...frames].join('\n') });

let errors: string[];
let origError: typeof console.error;
let dir: string;

beforeEach(() => {
  _resetModuleCrashes();
  clearLoadFailures();
  errors = [];
  origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  dir = path.resolve(path.dirname(crashFilePath()), 'ra53mods');
});

afterEach(() => {
  console.error = origError;
  _resetModuleCrashes();
  clearLoadFailures();
  fs.rmSync(crashFilePath(), { recursive: true, force: true });
  fs.rmSync(storeRecordPath(), { recursive: true, force: true });
});

describe('the apply tail of an install from nothing', () => {
  it('says the error keeps no copy of the module', () => {
    const applying = { from: 'absent', to: 'sha-new', backup: null, displaced: 'backups', tag: null, version: '2.0.0', updatedBy: null };
    writeStore(JSON.stringify({ docs: {}, modules: { m: entry({ applying: applying as any }) } }));
    expect(applyTails(start('m', 'sha-new')).t27).toBe(
      '; this machine finishes applying 2.0.0 when they finish without an error, or at 10 minutes; an error makes it keep no copy of m',
    );
  });
});

describe('the failure a start ended with', () => {
  it('is gone once a new start of the module opens', async () => {
    await endStart(opened('m', null), { failed: new Error('boom') });
    expect(startFailureOf('m')).toBe('boom');
    opened('m', null);
    expect(startFailureOf('m')).toBeUndefined();
  });

  it('is gone after the reset', async () => {
    await endStart(opened('m', null), { rejected: new Error('no') });
    expect(startFailureOf('m')).toBe('no');
    _resetModuleCrashes();
    expect(startFailureOf('m')).toBeUndefined();
  });
});

describe('the boot loop over a module whose start end failed', () => {
  it('skips it and records it as a load failure', () => {
    startEnds.set('m', 'failed');
    expect(onModuleCode({ name: 'm', path: '/nowhere', version: '1.0.0' })).toBe('skip');
    expect(getLoadFailures()).toEqual(['m']);
  });
});

describe('a boot start handed to its turn', () => {
  it('is forgotten by the reset', () => {
    const s = start('m', 'sha-a');
    handToBootTurn(s);
    expect(bootStartOf('m')).toBe(s);
    _resetModuleCrashes();
    expect(bootStartOf('m')).toBeUndefined();
  });
});

describe('removing a step run after each start ends', () => {
  it('a removed step does not run, and a second removal leaves the other step in place', async () => {
    const ran: string[] = [];
    const removeA = onStartEnded(s => { ran.push(`a:${s.module}`); });
    const removeB = onStartEnded(s => { ran.push(`b:${s.module}`); });
    try {
      removeA();
      removeA();
      await endStart(opened('m', null), 'ok');
      expect(ran).toEqual(['b:m']);
    } finally {
      removeB();
      removeA();
    }
  });

  it('the first step registered is removed', async () => {
    const ran: string[] = [];
    const removeA = onStartEnded(() => { ran.push('a'); });
    removeA();
    await endStart(opened('m', null), 'ok');
    expect(ran).toEqual([]);
  });
});

describe('the end of a start whose module has no crash line', () => {
  it('logs nothing and keeps no end for a retry, with no crash file', async () => {
    await endStart(opened('m', 'sha-a'), 'ok');
    expect(errors).toEqual([]);
    expect(keptEnds.has('m')).toBe(false);
  });

  it('leaves the other module\'s line in place', async () => {
    const line = { sha: 'sha-o', n: 1, version: '1', error: 'e', at: 'now' };
    writeCrashes(JSON.stringify({ other: line }));
    await endStart(opened('m', 'sha-a'), 'ok');
    expect(errors).toEqual([]);
    expect(keptEnds.has('m')).toBe(false);
    expect(JSON.parse(fs.readFileSync(crashFilePath(), 'utf8'))).toEqual({ other: line });
  });
});

describe('frameUnder', () => {
  const file = () => path.join(dir, 'a.js');

  it('a frame in parentheses with text after it is no frame', () => {
    expect(frameUnder(stackOf(`    at f (${file()}:1:2)trailing`), dir)).toBe(false);
  });

  it('a frame in parentheses at a line number of two digits names the file', () => {
    expect(frameUnder(stackOf(`    at f (${file()}:12:3)`), dir)).toBe(true);
  });

  it('a bare frame at a line number of two digits names the file', () => {
    expect(frameUnder(stackOf(`    at ${file()}:12:3`), dir)).toBe(true);
  });

  it('a line where "at" is not the first word is no frame', () => {
    expect(frameUnder(stackOf(`    xat ${file()}:1:2`), dir)).toBe(false);
  });

  it('a bare frame with text after it is no frame', () => {
    expect(frameUnder(stackOf(`    at ${file()}:1:2 trailing`), dir)).toBe(false);
  });

  it('a bare frame with trailing spaces names the file', () => {
    expect(frameUnder(stackOf(`    at ${file()}:1:2   `), dir)).toBe(true);
  });

  it('undefined answers false without a throw', () => {
    expect(frameUnder(undefined, dir)).toBe(false);
  });

  it('a file URL that cannot become a path is skipped', () => {
    const cwd = process.cwd();
    expect(frameUnder(stackOf('    at f (file:///x%2Fa.js:1:2)'), cwd)).toBe(false);
  });

  it('off Windows, a frame whose path differs only in case is not under the folder', () => {
    const upper = path.join(dir, 'UP');
    const lower = path.join(dir, 'up', 'a.js');
    withPlatform('linux', () => {
      expect(frameUnder(stackOf(`    at f (${lower}:1:2)`), upper)).toBe(false);
    });
    withPlatform('win32', () => {
      expect(frameUnder(stackOf(`    at f (${lower}:1:2)`), upper)).toBe(true);
    });
  });

  it('on Windows, the fold is to lower case: a dotless i and an i differ', () => {
    const dotless = String.fromCharCode(0x131);
    const folder = path.join(dir, `k${dotless}`);
    const frame = path.join(dir, 'ki', 'a.js');
    withPlatform('win32', () => {
      expect(frameUnder(stackOf(`    at f (${frame}:1:2)`), folder)).toBe(false);
    });
  });
});
