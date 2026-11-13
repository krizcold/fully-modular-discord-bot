import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// moduleReloader.ts: T31's (d) and (f) texts, the parse of tsc's diagnostics, and one compile's result, with tsc's exec
// scripted and the working directory a throwaway folder so the asset copy lands there.

const h = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; options: any }>,
  answer: null as (Error & { stdout?: string; stderr?: string }) | null,
  buildRoot: 'Z:/rm4-no-build-root',
}));

vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  const exec = (command: string, options: any, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    h.calls.push({ command, options });
    if (command.includes('tsc') && h.answer) {
      const error = h.answer;
      callback(error, error.stdout, error.stderr);
      return;
    }
    callback(null, '', '');
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), getBuildRoot: () => h.buildRoot }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseDiagnostics, recompileTypeScript, reloadRefusedText } from '../../src/bot/internalSetup/utils/moduleReloader';

let root = '';

beforeEach(() => {
  h.calls = [];
  h.answer = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm4c-'));
  h.buildRoot = path.join(root, 'build');
  fs.mkdirSync(path.join(h.buildRoot, 'mod'), { recursive: true });
  fs.writeFileSync(path.join(h.buildRoot, 'mod', 'module.json'), '{"name":"mod"}');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const failure = (fields: { message?: string; stdout?: string; stderr?: string }) =>
  Object.assign(new Error(fields.message ?? 'Command failed: tsc'), fields.stdout === undefined ? {} : { stdout: fields.stdout }, fields.stderr === undefined ? {} : { stderr: fields.stderr });
const copied = () => fs.existsSync(path.join(root, 'dist', 'mod', 'module.json'));

describe('T31 texts of a refused reload', () => {
  it('(d): the module is being loaded right now', () => {
    expect(reloadRefusedText('m', 'd')).toBe('m was not reloaded: this machine is loading it right now. Try again once that load finishes.');
  });

  it('(f): the module\'s last change is still being finished', () => {
    expect(reloadRefusedText('m', 'f')).toBe('m was not reloaded: this machine is still finishing its last change of m. Try again in a few minutes.');
  });
});

describe('parseDiagnostics', () => {
  const cwd = path.resolve('/rm4-cwd');

  it('reads a line number of more than one digit', () => {
    expect(parseDiagnostics('bot/m/index.ts(12,3): error TS2322: Type mismatch.', cwd)).toEqual([
      { file: 'bot/m/index.ts', line: 12, code: 2322, text: 'Type mismatch.' },
    ]);
  });

  it('splits output with LF-only line ends into one diagnostic per line', () => {
    expect(parseDiagnostics('a.ts(1,1): error TS1005: one.\nb.ts(2,2): error TS1006: two.', cwd)).toEqual([
      { file: 'a.ts', line: 1, code: 1005, text: 'one.' },
      { file: 'b.ts', line: 2, code: 1006, text: 'two.' },
    ]);
  });

  it('trims the indent before the file name', () => {
    expect(parseDiagnostics('   a.ts(4,1): error TS2304: Cannot find name.', cwd)).toEqual([
      { file: 'a.ts', line: 4, code: 2304, text: 'Cannot find name.' },
    ]);
  });

  it('takes no diagnostic out of a line a lone carriage return splits', () => {
    expect(parseDiagnostics('progress\ra.ts(1,1): error TS1005: one.', cwd)).toEqual([]);
    expect(parseDiagnostics('a.ts(1,1): error TS1005: one.\rprogress', cwd)).toEqual([]);
  });
});

describe('one compile', () => {
  it('on Linux, a compile that succeeds runs sync with the 60 s bound, and its duration is the time it took', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      const result = await recompileTypeScript();
      expect(result).toMatchObject({ success: true, diagnostics: [] });
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.duration).toBeLessThan(10_000);
      expect(h.calls.map(c => c.command).filter(c => !c.includes('tsc'))).toEqual(['sync']);
      expect(h.calls.find(c => c.command === 'sync')?.options).toEqual({ timeout: 60_000 });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('a failure with type errors in stderr: the diagnostics, the assets copied beside the emitted JS, the duration it took', async () => {
    h.answer = failure({ stdout: '', stderr: 'bot/m/index.ts(3,4): error TS2322: bad type.' });
    const result = await recompileTypeScript();
    expect(result).toMatchObject({
      success: false,
      error: 'bot/m/index.ts(3,4): error TS2322: bad type.',
      diagnostics: [{ file: 'bot/m/index.ts', line: 3, code: 2322, text: 'bad type.' }],
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(10_000);
    expect(copied()).toBe(true);
  });

  it('a failure with no type error copies no asset', async () => {
    h.answer = failure({ stdout: '', stderr: 'error TS5058: The specified path does not exist.' });
    const result = await recompileTypeScript();
    expect(result).toMatchObject({ success: false, diagnostics: [] });
    expect(copied()).toBe(false);
  });

  it('a failure that has no stderr answers its message and no diagnostics', async () => {
    h.answer = failure({ message: 'spawn tsc ENOENT', stdout: 'nothing' });
    const result = await recompileTypeScript();
    expect(result).toMatchObject({ success: false, error: 'spawn tsc ENOENT', diagnostics: [] });
    expect(copied()).toBe(false);
  });
});
