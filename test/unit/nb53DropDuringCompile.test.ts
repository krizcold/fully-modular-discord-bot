import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB53 (NB45's re-review): a module's dist folder deleted while a hot reload's compile runs. tsc writes its incremental
// record when it ends; the scripted tsc below is held open until a row lets it write that record and answer.

const h = vi.hoisted(() => ({
  held: null as null | (() => void),
  started: null as null | (() => void),
  writeRecord: null as null | (() => void),
  realCompile: null as null | ((opts?: { timeoutMs?: number }) => Promise<import('../../src/bot/internalSetup/utils/moduleReloader').CompileResult>),
}));

vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    exec: (command: string, _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (!/tsc(\.cmd)?" -p tsconfig\.json$/.test(command)) {
        callback(null, '', '');
        return;
      }
      h.held = () => {
        h.writeRecord?.();
        callback(null, '', '');
      };
      h.started?.();
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), getBuildRoot: () => 'Z:/nb53-no-build-root' }));

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  h.realCompile = real.recompileTypeScript;
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import fs from 'fs';
import path from 'path';
import { applyRig } from '../helpers/nb6ApplyRig';

const rig = applyRig();
const FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.ts': 'export {};\n' };
const record = () => path.join(rig.state.root, 'dist', '.tsbuildinfo');
const recordText = (): string | null => (fs.existsSync(record()) ? fs.readFileSync(record(), 'utf8') : null);

/** The real recompileTypeScript, answered once tsc's exec is running. */
async function heldCompile(): Promise<{ result: Promise<unknown> }> {
  const started = new Promise<void>(resolve => { h.started = resolve; });
  const result = h.realCompile!();
  await started;
  return { result };
}

beforeEach(async () => {
  await rig.setup();
  h.held = null;
  h.started = null;
  h.writeRecord = () => fs.writeFileSync(record(), JSON.stringify({ program: { fileNames: ['./build/bot/modules/m/index.ts'] }, emitted: ['./dist/bot/modules/m/index.js'] }));
});
afterEach(async () => {
  h.held?.();
  h.writeRecord = null;
  await rig.teardown();
});

describe("a module's dist folder deleted while a compile runs", () => {
  it('nb53 drop during compile: the record the compile writes at its end is deleted, so it lists no deleted output', async () => {
    await rig.inPlace('m', FILES);
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'exports.x = 1;\n' });
    fs.writeFileSync(record(), '{"old":true}');

    const compile = await heldCompile();
    await rig.unpublish('m');
    await rig.pass();
    expect(rig.dist('m')).toBeNull();

    h.held!();
    h.held = null;
    expect(await compile.result).toMatchObject({ success: true });
    expect(rig.dist('m')).toBeNull();
    expect(recordText()).toBeNull();
  });

  it('nb53 no drop during compile: the record the compile writes stays', async () => {
    await rig.inPlace('m', FILES);
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'exports.x = 1;\n' });

    const compile = await heldCompile();
    h.held!();
    h.held = null;
    expect(await compile.result).toMatchObject({ success: true });
    expect(recordText()).toContain('bot/modules/m/index.ts');
  });

  it('nb53 drop before the compile: the next compile keeps the record it writes', async () => {
    await rig.inPlace('m', FILES);
    rig.writeTree(path.join(rig.state.dist, 'm'), { 'index.js': 'exports.x = 1;\n' });
    fs.writeFileSync(record(), '{"old":true}');
    await rig.unpublish('m');
    await rig.pass();
    expect(recordText()).toBeNull();

    const compile = await heldCompile();
    h.held!();
    h.held = null;
    expect(await compile.result).toMatchObject({ success: true });
    expect(recordText()).toContain('bot/modules/m/index.ts');
  });
});
