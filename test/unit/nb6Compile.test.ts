import { afterEach, describe, expect, it, vi } from 'vitest';

// NB6 test 48 (wip-redesign/sheets/NB6.md decisions 46 and 81): the queued compile. Rows 138 and 139 with tsc's exec
// scripted; the diagnostics parse on the output of the project's own tsc run over a fixture tree with a type error in
// one module folder.

const h = vi.hoisted(() => ({
  runs: [] as Array<{ timeout: number | undefined; finish: (error: (Error & { stdout?: string; stderr?: string }) | null) => void }>,
}));

vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    exec: (command: string, options: { timeout?: number }, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (command === 'sync') {
        callback(null, '', '');
        return;
      }
      h.runs.push({ timeout: options?.timeout, finish: error => callback(error, error ? error.stdout : '', error ? error.stderr : '') });
    },
  };
});

// The compile's asset copy reads the build root: none here, so nothing is copied beside the test.
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), getBuildRoot: () => 'Z:/nb6-no-build-root' }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { parseDiagnostics, recompileTypeScript } from '../../src/bot/internalSetup/utils/moduleReloader';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const failed = (stdout: string) => Object.assign(new Error('Command failed: tsc'), { stdout, stderr: '' });

afterEach(() => {
  for (const run of h.runs.splice(0)) run.finish(null);
});

describe('row 138: a request while a compile runs', () => {
  it('waits for it, then shares the next compile, which starts after every call that joined it', async () => {
    const first = recompileTypeScript();
    expect(h.runs).toHaveLength(1);
    const second = recompileTypeScript();
    const third = recompileTypeScript();
    await flush();
    expect(h.runs).toHaveLength(1);
    h.runs[0].finish(null);
    expect((await first).success).toBe(true);
    await flush();
    expect(h.runs).toHaveLength(2);
    h.runs[1].finish(failed('bot/modules/m/index.ts(2,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n'));
    const [b, c] = await Promise.all([second, third]);
    expect(b).toEqual(c);
    expect(b).toMatchObject({ success: false, diagnostics: [{ file: 'bot/modules/m/index.ts', line: 2, code: 2322, text: "Type 'string' is not assignable to type 'number'." }] });
  });
});

describe('row 139: a reload route\'s compile overlaps an apply\'s', () => {
  it('the apply\'s result comes from a compile started after its call, run with the largest bound of its callers', async () => {
    const reload = recompileTypeScript();
    const apply = recompileTypeScript({ timeoutMs: 600_000 });
    const other = recompileTypeScript();
    expect(h.runs.map(r => r.timeout)).toEqual([60_000]);
    h.runs[0].finish(failed('bot/modules/m/index.ts(1,1): error TS1005: the source before the swap.\n'));
    expect((await reload).diagnostics).toHaveLength(1);
    await flush();
    expect(h.runs.map(r => r.timeout)).toEqual([60_000, 600_000]);
    h.runs[1].finish(null);
    expect(await apply).toMatchObject({ success: true, diagnostics: [] });
    expect(await other).toMatchObject({ success: true });
  });
});

describe('the diagnostics of a real tsc run', () => {
  it('names the file under the working directory, its line, code and text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6tsc-'));
    try {
      fs.mkdirSync(path.join(root, 'bot', 'modules', 'broken'), { recursive: true });
      fs.mkdirSync(path.join(root, 'bot', 'modules', 'fine'), { recursive: true });
      fs.writeFileSync(path.join(root, 'bot', 'modules', 'broken', 'index.ts'), "export const n: number = 1;\nexport const s: number = 'not a number';\n");
      fs.writeFileSync(path.join(root, 'bot', 'modules', 'fine', 'index.ts'), 'export const ok = 1;\n');
      fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['bot/**/*.ts'] }));
      const tsc = path.resolve(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
      const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(parseDiagnostics(`${run.stdout}\n${run.stderr}`, root)).toEqual([
        { file: 'bot/modules/broken/index.ts', line: 2, code: 2322, text: "Type 'string' is not assignable to type 'number'." },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
